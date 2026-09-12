import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition, ToolCall } from '@tkottke90/inference-adapter';
import type { RegisteredTool, McpServerConfig, McpConfigFile } from './types.js';
import { readMcpConfig, writeMcpConfig, parseMcpSource } from './internal/mcp-config.js';
import { buildMcpClient, fetchAllMcpTools } from './internal/mcp-client.js';
import type { McpServerStatus } from './internal/mcp-client.js';
import type { MultiServerMCPClient } from '@langchain/mcp-adapters';

const MCP_FILE = 'mcp.json';

export class ToolsManager {
  private readonly configDir: string;
  private readonly mcpFilePath: string;

  private builtins: Map<string, RegisteredTool> = new Map();
  private mcpTools: Map<string, RegisteredTool> = new Map();
  private mcpClients: Map<string, MultiServerMCPClient> = new Map();
  private mcpServerStatuses: Map<string, McpServerStatus> = new Map();
  private mcpConfig: McpConfigFile = { mcpServers: {} };
  private mcpInitialized = false;

  constructor(opts: { configDir: string }) {
    this.configDir = opts.configDir;
    this.mcpFilePath = join(opts.configDir, MCP_FILE);
  }

  async boot(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    let fileExists = true;
    try {
      await readFile(this.mcpFilePath);
    } catch {
      fileExists = false;
    }
    if (!fileExists) {
      this.mcpConfig = { mcpServers: {} };
      await writeMcpConfig(this.mcpFilePath, this.mcpConfig);
    } else {
      this.mcpConfig = await readMcpConfig(this.mcpFilePath);
    }
    this.mcpClients = buildMcpClient(this.mcpConfig);
    this.mcpInitialized = false;
  }

  async close(): Promise<void> {
    for (const client of this.mcpClients.values()) await client.close();
    this.mcpTools.clear();
    this.mcpInitialized = false;
    this.mcpClients = new Map();
  }

  // ── Built-in registration ────────────────────────────────────────────────

  register(tool: RegisteredTool): void {
    this.builtins.set(tool.name, tool);
  }

  // ── MCP server management ────────────────────────────────────────────────

  async importMcpConfig(source: string | Buffer): Promise<void> {
    const imported = await parseMcpSource(source);
    this.mcpConfig = { mcpServers: { ...imported.mcpServers } };
    await writeMcpConfig(this.mcpFilePath, this.mcpConfig);
    await this._resetMcpClient();
  }

  async addMcpServer(name: string, config: McpServerConfig): Promise<void> {
    if (name in this.mcpConfig.mcpServers) {
      throw new Error(`MCP server "${name}" already exists`);
    }
    this.mcpConfig.mcpServers[name] = config;
    await writeMcpConfig(this.mcpFilePath, this.mcpConfig);
    await this._resetMcpClient();
  }

  async editMcpServer(name: string, config: Partial<McpServerConfig>): Promise<void> {
    this.assertMcpServerExists(name);
    const existing = this.mcpConfig.mcpServers[name]!;
    // Cast required: spreading Partial<union> does not narrow the discriminated union
    this.mcpConfig.mcpServers[name] = { ...existing, ...config } as McpServerConfig;
    await writeMcpConfig(this.mcpFilePath, this.mcpConfig);
    await this._resetMcpClient();
  }

  async removeMcpServer(name: string): Promise<void> {
    this.assertMcpServerExists(name);
    delete this.mcpConfig.mcpServers[name];
    await writeMcpConfig(this.mcpFilePath, this.mcpConfig);
    await this._resetMcpClient();
  }

  listMcpServers(): Record<string, McpServerConfig> {
    return { ...this.mcpConfig.mcpServers };
  }

  // ── Runtime ──────────────────────────────────────────────────────────────

  async getTools(filter?: string[]): Promise<ToolDefinition[]> {
    await this._ensureMcpInitialized();
    // Cast required: RegisteredTool.parameters uses local zod; ToolDefinition.parameters
    // uses inference-adapter's zod — structurally identical but different module instances.
    const definitions = this._allTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })) as unknown as ToolDefinition[];
    if (!filter || filter.length === 0) return definitions;
    const allowed = new Set(filter);
    return definitions.filter((d) => allowed.has(d.name));
  }

  // Forces a fresh MCP fetch attempt, bypassing the "only fetch once, ever,
  // until a config change resets it" gate _ensureMcpInitialized normally
  // applies. Used by an explicit user-triggered refresh action — routine
  // calls (getTools()/execute()) deliberately do NOT get this, so they never
  // reconnect to every server on every chat turn.
  async refreshMcpTools(): Promise<void> {
    this.mcpInitialized = false;
    await this._ensureMcpInitialized();
  }

  async execute(call: ToolCall): Promise<unknown> {
    await this._ensureMcpInitialized();
    const builtin = this.builtins.get(call.name);
    if (builtin !== undefined) return builtin.execute(call.arguments);
    const mcpTool = this.mcpTools.get(call.name);
    if (mcpTool !== undefined) return mcpTool.execute(call.arguments);
    throw new Error(`Unknown tool: "${call.name}"`);
  }

  list(): RegisteredTool[] {
    return this._allTools();
  }

  // Per-server connected/unreachable outcome of the most recent fetch
  // attempt. Empty until getTools()/list()-triggered initialization has run
  // at least once — this never itself triggers a connection, matching the
  // "no side effects from merely reading state" principle used elsewhere in
  // this app's MCP tooling (e.g. the settings UI never auto-checks on page
  // load).
  getMcpServerStatuses(): Map<string, McpServerStatus> {
    return new Map(this.mcpServerStatuses);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _ensureMcpInitialized(): Promise<void> {
    if (this.mcpClients.size > 0 && !this.mcpInitialized) {
      const { tools, statuses } = await fetchAllMcpTools(this.mcpClients);
      this.mcpTools.clear();
      for (const t of tools) this.mcpTools.set(t.name, t);
      this.mcpServerStatuses = statuses;
      this.mcpInitialized = true;
    }
  }

  private async _resetMcpClient(): Promise<void> {
    for (const client of this.mcpClients.values()) await client.close();
    this.mcpTools.clear();
    this.mcpInitialized = false;
    this.mcpClients = buildMcpClient(this.mcpConfig);
  }

  private _allTools(): RegisteredTool[] {
    return [...this.builtins.values(), ...this.mcpTools.values()];
  }

  private assertMcpServerExists(name: string): void {
    if (!(name in this.mcpConfig.mcpServers)) {
      throw new Error(`MCP server "${name}" not found`);
    }
  }
}
