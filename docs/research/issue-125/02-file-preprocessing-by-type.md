# Research: Pre-Processing Required per File Type Before Multi-Modal Consumption

Research for [issue #125](https://github.com/tkottke90/amazing-hashbrown/issues/125). Findings verified by a 3-vote adversarial pass; provider limits checked directly against live vendor docs.

## 1. Overview of the Question

Once we know a model accepts a given input modality (see doc 01), the raw uploaded file still isn't necessarily in a form the model API will accept. What conversion, encoding, or extraction step is required per file type — image, PDF, other document — before it can go into a message sent through LangChain to a provider?

## 2. Information Found

**There is no single universal preprocessing step — requirements are split between a LangChain-level format requirement and provider-specific hard limits.**

### LangChain message-format requirement (applies regardless of provider)

- LangChain's multimodal content blocks (image/audio/video/file) that carry **base64 data require an explicit `mime_type` field** (e.g. `image/jpeg`) alongside the payload. This is consistent across all base64-based block types.
- Content blocks that reference the file **by URL do not need `mime_type`** — the provider fetches and identifies the file itself.
- So at minimum, any uploaded file destined for base64 submission needs: file bytes read → base64-encode → attach the correct `mime_type`, detected from the upload (not guessed from extension alone, since extensions lie).

### Text extraction for images / scanned documents

LangChain Community ships dedicated parsers for turning non-text content into text before it ever reaches the model, when the goal is extraction rather than vision-model consumption:

- **`TesseractBlobParser`** and **`RapidOCRBlobParser`** — pure OCR, no LLM call. Good for scanned text where you don't need/want to spend a vision-model call.
- **`LLMImageBlobParser`** — a distinct code path: hands the image plus a prompt to a caller-supplied vision-capable model to summarize or extract text. This is what you use when you _do_ want a multi-modal model in the loop (e.g. "describe this screenshot" rather than "OCR this scanned invoice").

These matter for the "non-image files" case noted in the issue's Dev Notes (extracting text server-side and prepending it as context) — this is the existing LangChain-native mechanism for that, rather than something to build from scratch.

### Provider-specific hard constraints (these are the real gotchas)

**Anthropic (Claude) — vision API:**

- Accepts **JPEG, PNG, GIF, WebP only**. Anything else (e.g. BMP, TIFF, HEIC) must be converted first.
- Animated GIFs are reduced to their **first frame only** — no animation support.
- Exactly **three submission modes**: base64, remote URL, or a `file_id` from the Files API.
- Hard limits: max **8000×8000px**, and a **10MB cap on the base64-encoded payload** — both of which mean the harness needs to resize/recompress oversized images before sending, not just reject them outright.

**Google Gemini / Firebase AI Logic:**

- Inline base64 images are accepted, but **base64 encoding itself inflates payload size** (~33% larger than raw bytes), and the **total request size is capped at 20MB** on the Firebase AI Logic surface.
- The Files API is recommended instead for large files, or when the same file will be reused across multiple requests.
- One claim we checked and **refuted**: Firebase does _not_ auto-tile/auto-resize oversized images for you (a specific "auto-tiles images >384×384" claim failed adversarial verification 1-2). Don't rely on the platform to resize on your behalf on this surface — treat resizing as the harness's job unless a specific vendor doc says otherwise for the exact API you're calling.
- Note: the raw Gemini Developer API (as opposed to Firebase AI Logic) may have a different, higher cap on a separate surface per more recent vendor announcements — the 20MB figure is specific to the Firebase AI Logic input path, not necessarily every Gemini entry point.

## 3. How This Is Implemented Successfully (At Scale)

This is exactly the shape of pipeline the major LLM API vendors already document as their expected client-side integration path, and it's what LangChain's own community loaders wrap:

1. **Detect real MIME type from bytes**, not the filename extension.
2. **Branch on modality + provider capability** (from doc 01's `.profile` check):
   - Image, vision-capable model → convert to an accepted format if needed (e.g. HEIC → JPEG), resize/recompress if over the provider's dimension/size cap, base64-encode with correct `mime_type` (or upload via a Files API and pass a reference — see doc 03 for the tradeoffs there).
   - Image, non-vision model, or "just get me searchable text" use case → OCR via `TesseractBlobParser`/`RapidOCRBlobParser`, or `LLMImageBlobParser` if a vision model is available for extraction, then treat the output as plain text context.
   - Other document types (PDF, docx, etc.) → LangChain Community document loaders (`PyPDFLoader`, `PyMuPDFLoader`, etc.) already integrate the OCR/LLM-image parsers above for embedded images inside those documents.
3. **Enforce provider limits before sending**, not after — reject or downscale client-side so a 400 from the vendor API never reaches the user as an opaque error.

The concrete numeric limits (8000×8000px / 10MB for Claude; 20MB request cap for Firebase/Gemini) are the kind of thing that changes over time — treat them as "check live docs before hardcoding," not as constants to bake in permanently.

## 4. References

- LangChain message content blocks / `mime_type` requirement: https://docs.langchain.com/oss/python/langchain/messages
- LangChain Community document loaders reference (OCR + LLM image parsers): https://reference.langchain.com/python/langchain-community/document-loaders
- Anthropic Claude vision docs (formats, GIF handling, submission modes, size/dimension limits): https://platform.claude.com/docs/en/build-with-claude/vision
- Google Gemini image understanding docs: https://ai.google.dev/gemini-api/docs/image-understanding
- Firebase AI Logic input file requirements (20MB cap, Files API recommendation): https://firebase.google.com/docs/ai-logic/input-file-requirements

## Caveat

This research focused primarily on images, since that's the attachment type explicitly called out in issue #125's Dev Notes. Audio, video, and mixed-content PDFs likely have their own provider-specific limits that weren't covered here — check vendor docs per file type before extending this beyond images.
