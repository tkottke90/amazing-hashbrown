import { useSignal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { TaskDrawer } from '@/components/task-drawer';
import { LANE_LABELS, requestMove } from '@/components/task-board/board-move';
import { queueState } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';
import type { Lane, Task } from '@/services/tasks-api';
import { BoardCard } from './board-card';
import {
  LANE_ORDER,
  LANE_SUBTITLES,
  laneDropId,
  laneOf,
  reorderableQueue,
  resolveDrop,
  tasksByLane,
} from './lanes';

// Cards sit inside lanes, and both are drop targets: prefer the card under
// the pointer (a Queue reorder slot) over the lane around it. Keyboard drags
// have no pointer, so use what the dragged card overlaps, then the nearest
// target.
const collisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const overlaps = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
  const found = overlaps.length > 0 ? overlaps : closestCorners(args);
  const cards = found.filter((c) => !String(c.id).startsWith('lane:'));
  return cards.length > 0 ? cards : found;
};

// Keyboard moves: Left/Right jump the card to the neighbouring lane; Up/Down
// step through the Queue's sortable slots. (dnd-kit's sortable getter alone
// can't carry a card that isn't itself sortable across lanes.)
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') {
    return sortableKeyboardCoordinates(event, args);
  }
  const { collisionRect, droppableRects } = args.context;
  if (!collisionRect) return undefined;
  event.preventDefault();

  const lanes = LANE_ORDER.map((l) => droppableRects.get(laneDropId(l))).filter(
    (rect): rect is NonNullable<typeof rect> => rect !== undefined,
  );
  const centre = collisionRect.left + collisionRect.width / 2;
  const current = lanes.findIndex((rect) => centre >= rect.left && centre <= rect.right);
  const target = lanes[current + (event.code === 'ArrowRight' ? 1 : -1)];
  if (current === -1 || !target) return undefined;
  return {
    x: target.left + (target.width - collisionRect.width) / 2,
    y: target.top + 56,
  };
};

// Whether `lane` accepts the card being dragged: a lane the server lists in
// the card's moves, other than its own — except the Queue, where a queued
// card may be dropped to reorder.
export function laneAccepts(task: Task, lane: Lane): boolean {
  if (!task.board?.moves.some((m) => m.to === lane)) return false;
  return lane !== laneOf(task) || (lane === 'queue' && task.status === 'ready');
}

type CardDomProps = JSX.HTMLAttributes<HTMLDivElement>;

// dnd-kit's attributes/listeners are typed for React DOM; they're the same
// DOM props under preact/compat. Merges them with the card's own click/Enter
// handler (Enter opens the drawer; Space is reserved for picking the card up).
function cardProps(
  task: Task,
  onOpen: (task: Task) => void,
  attributes: object,
  listeners: object | undefined,
): CardDomProps {
  const drag = { ...attributes, ...listeners } as CardDomProps & {
    onKeyDown?: (e: KeyboardEvent) => void;
  };
  return {
    ...drag,
    onClick: () => onOpen(task),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') onOpen(task);
      drag.onKeyDown?.(e);
    },
  };
}

// A queued card: draggable between lanes and sortable within the Queue.
function SortableCard({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !task.board?.moves.length,
  });
  return (
    <BoardCard
      ref={setNodeRef}
      task={task}
      dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform) ?? undefined, transition }}
      {...cardProps(task, onOpen, attributes, listeners)}
    />
  );
}

// Any other card: draggable to another lane, not sortable.
function DraggableCard({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !task.board?.moves.length,
  });
  return (
    <BoardCard
      ref={setNodeRef}
      task={task}
      dragging={isDragging}
      {...cardProps(task, onOpen, attributes, listeners)}
    />
  );
}

function BoardLane({
  lane,
  count,
  activeTask,
  children,
}: {
  lane: Lane;
  count: number;
  activeTask: Task | null;
  children: ComponentChildren;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: laneDropId(lane) });
  const dropState = !activeTask ? 'idle' : laneAccepts(activeTask, lane) ? 'allowed' : 'blocked';
  const ownLane = activeTask !== null && laneOf(activeTask) === lane;

  return (
    <section
      ref={setNodeRef}
      data-column={lane}
      data-drop-state={dropState}
      data-over={isOver ? 'true' : undefined}
      aria-label={LANE_LABELS[lane]}
      class={cn(
        'flex min-h-[240px] min-w-0 flex-col gap-2 rounded-xl border-2 border-transparent bg-muted p-2.5 transition-colors',
        dropState === 'allowed' && !ownLane && 'border-dashed border-primary/50',
        dropState === 'allowed' && isOver && 'bg-primary/5',
        dropState === 'blocked' && !ownLane && 'opacity-50',
      )}
    >
      <header class="px-1">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-semibold">{LANE_LABELS[lane]}</h3>
          <span class="text-xs text-muted-foreground" data-testid="lane-count">
            {count}
          </span>
        </div>
        <p class="text-[11px] text-muted-foreground">{LANE_SUBTITLES[lane]}</p>
      </header>
      {children}
    </section>
  );
}

// The desktop Tasks tab: five lanes grouped by who acts next, drag-and-drop
// between them (mouse and keyboard: Space picks a card up, arrows move it,
// Space drops it). Where a card may go comes from the server's board
// projection; see components/task-board/board-move.ts for what a drop does.
export function TaskBoard({
  workspaceId,
  taskList,
  onSaved,
  onGoToChat,
}: {
  workspaceId: string;
  taskList: Task[];
  onSaved: () => void;
  onGoToChat: () => void;
}) {
  const lanes = tasksByLane(taskList, queueState.value);
  const activeId = useSignal<string | null>(null);
  const activeTask = activeId.value
    ? (taskList.find((t) => t.id === activeId.value) ?? null)
    : null;

  // One drawer for the whole board, opened on whichever card was clicked.
  const drawerOpen = useSignal(false);
  const selectedId = useSignal<string | null>(null);
  // Looked up on every render, not memoized: `taskList` is a plain prop, and
  // a task created after the board mounted must still be found.
  const selected = taskList.find((t) => t.id === selectedId.value) ?? null;
  const openTask = (task: Task) => {
    selectedId.value = task.id;
    drawerOpen.value = true;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  function onDragStart(event: DragStartEvent) {
    activeId.value = String(event.active.id);
  }

  function onDragEnd(event: DragEndEvent) {
    const task = taskList.find((t) => t.id === event.active.id);
    activeId.value = null;
    if (!task || !event.over) return;
    const target = resolveDrop(task, String(event.over.id), lanes);
    if (!target || !laneAccepts(task, target.to)) return;
    requestMove(task, target.to, { position: target.position, onReply: openTask });
  }

  const running = taskList.filter((t) => t.status === 'running').length;
  const sortableIds = reorderableQueue(lanes).map((t) => t.id);

  return (
    <div class="p-4">
      <div class="mb-3 flex items-center justify-between">
        <p class="text-xs text-muted-foreground" data-testid="task-board-summary">
          {taskList.length} {taskList.length === 1 ? 'task' : 'tasks'} · {running} running · queue
          runs one at a time
        </p>
        <TaskDrawer
          task={null}
          defaultWorkspaceId={workspaceId}
          onSaved={onSaved}
          trigger={
            <Button size="sm">
              <Plus class="size-3.5" />
              Add task
            </Button>
          }
        />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => (activeId.value = null)}
      >
        <div class="grid grid-cols-5 gap-3" data-testid="task-board">
          {LANE_ORDER.map((lane) => (
            <BoardLane key={lane} lane={lane} count={lanes[lane].length} activeTask={activeTask}>
              {lane === 'queue' ? (
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  {lanes.queue.map((task) =>
                    task.status === 'ready' ? (
                      <SortableCard key={task.id} task={task} onOpen={openTask} />
                    ) : (
                      <DraggableCard key={task.id} task={task} onOpen={openTask} />
                    ),
                  )}
                </SortableContext>
              ) : (
                lanes[lane].map((task) => (
                  <DraggableCard key={task.id} task={task} onOpen={openTask} />
                ))
              )}
            </BoardLane>
          ))}
        </div>
        <DragOverlay>
          {activeTask ? <BoardCard task={activeTask} class="shadow-lg" /> : null}
        </DragOverlay>
      </DndContext>

      <TaskDrawer
        task={selected}
        open={drawerOpen}
        defaultWorkspaceId={workspaceId}
        onSaved={onSaved}
        onGoToChat={onGoToChat}
      />
    </div>
  );
}
