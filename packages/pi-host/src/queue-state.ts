import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QueueSnapshot } from "@piabyss/protocol";

type QueueState = QueueSnapshot & {
  transactionDepth: number;
  transactionStart?: Omit<QueueSnapshot, "revision">;
};

const states = new WeakMap<AgentSession, QueueState>();

function readQueue(session: AgentSession): Omit<QueueSnapshot, "revision"> {
  return {
    steering: [...session.getSteeringMessages()],
    followUp: [...session.getFollowUpMessages()],
  };
}

function queueEquals(
  left: Omit<QueueSnapshot, "revision">,
  right: Omit<QueueSnapshot, "revision">,
): boolean {
  return (
    left.steering.length === right.steering.length &&
    left.followUp.length === right.followUp.length &&
    left.steering.every((text, index) => text === right.steering[index]) &&
    left.followUp.every((text, index) => text === right.followUp[index])
  );
}

function stateFor(session: AgentSession): QueueState {
  let state = states.get(session);
  if (!state) {
    state = {
      revision: 0,
      ...readQueue(session),
      transactionDepth: 0,
    };
    states.set(session, state);
  }
  return state;
}

function snapshot(state: QueueState): QueueSnapshot {
  return {
    revision: state.revision,
    steering: [...state.steering],
    followUp: [...state.followUp],
  };
}

export function getQueueSnapshot(session: AgentSession): QueueSnapshot {
  return snapshot(stateFor(session));
}

export function beginQueueTransaction(session: AgentSession): QueueSnapshot {
  const state = stateFor(session);
  if (state.transactionDepth === 0) {
    state.transactionStart = {
      steering: [...state.steering],
      followUp: [...state.followUp],
    };
  }
  state.transactionDepth += 1;
  return snapshot(state);
}

export function observeQueueUpdate(
  session: AgentSession,
  nextQueue: Omit<QueueSnapshot, "revision"> = readQueue(session),
): { changed: boolean; suppressed: boolean; queue: QueueSnapshot } {
  const state = stateFor(session);
  const changed = !queueEquals(state, nextQueue);
  if (changed) {
    state.steering = [...nextQueue.steering];
    state.followUp = [...nextQueue.followUp];
    if (state.transactionDepth === 0) state.revision += 1;
  }
  return {
    changed,
    suppressed: state.transactionDepth > 0,
    queue: snapshot(state),
  };
}

export function finishQueueTransaction(session: AgentSession): {
  changed: boolean;
  queue: QueueSnapshot;
} {
  const state = stateFor(session);
  if (state.transactionDepth <= 0) {
    throw new Error("No active queue transaction");
  }

  const live = readQueue(session);
  state.steering = [...live.steering];
  state.followUp = [...live.followUp];
  state.transactionDepth -= 1;
  if (state.transactionDepth > 0) {
    return { changed: false, queue: snapshot(state) };
  }

  const start = state.transactionStart ?? live;
  const changed = !queueEquals(start, live);
  state.transactionStart = undefined;
  if (changed) state.revision += 1;
  return { changed, queue: snapshot(state) };
}
