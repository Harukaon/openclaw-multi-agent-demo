import { randomUUID } from "node:crypto";

export type GroupChatClientMessage = {
  type: string;
  [key: string]: unknown;
};

type AcceptedMessage = {
  messageId: string;
  seq: number;
  suppressed?: boolean;
};

export type GroupChatClientOptions = {
  serverUrl: string;
  agentId: string;
  token: string;
  log?: (message: string) => void;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function endpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/agent`;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class GroupChatClient {
  private socket: WebSocket | undefined;
  private closed = false;
  private readonly pendingMessages = new Map<string, {
    resolve: (accepted: AcceptedMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly options: GroupChatClientOptions) {}

  async run(
    signal: AbortSignal,
    onMessage: (message: GroupChatClientMessage) => Promise<void>,
    onConnected?: () => void,
    onDisconnected?: () => void,
  ): Promise<void> {
    let reconnectDelay = 500;
    while (!signal.aborted && !this.closed) {
      try {
        await this.connectOnce(signal, onMessage, onConnected, onDisconnected);
        reconnectDelay = 500;
      } catch (error) {
        this.options.log?.(`connection failed: ${error instanceof Error ? error.message : String(error)}`);
        if (signal.aborted || this.closed) break;
        await wait(reconnectDelay, signal);
        reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
      }
    }
  }

  send(message: GroupChatClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("group server is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  async sendAgentMessage(input: {
    groupId: string;
    content: string;
    parentMessageId?: string;
    rootMessageId?: string;
    depth?: number;
  }): Promise<AcceptedMessage> {
    const clientMessageId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(clientMessageId);
        reject(new Error("timed out waiting for Platform message acceptance"));
      }, 10_000);
      this.pendingMessages.set(clientMessageId, { resolve, reject, timer });
      try {
        this.send({ type: "agent.message", clientMessageId, ...input });
      } catch (error) {
        clearTimeout(timer);
        this.pendingMessages.delete(clientMessageId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.rejectPending(new Error("group server client closed"));
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close(1000, "plugin stopping");
    }
  }

  private connectOnce(
    signal: AbortSignal,
    onMessage: (message: GroupChatClientMessage) => Promise<void>,
    onConnected?: () => void,
    onDisconnected?: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint(this.options.serverUrl));
      this.socket = socket;
      let connected = false;
      let settled = false;
      let helloResolve: (() => void) | undefined;
      let helloReject: ((error: Error) => void) | undefined;
      let closeResolve: (() => void) | undefined;
      const hello = new Promise<void>((resolveHello, rejectHello) => {
        helloResolve = resolveHello;
        helloReject = rejectHello;
      });
      const closed = new Promise<void>((resolveClosed) => {
        closeResolve = resolveClosed;
      });
      const abort = () => socket.close(1000, "aborted");
      signal.addEventListener("abort", abort, { once: true });

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", agentId: this.options.agentId, token: this.options.token }));
      });
      socket.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        let message: GroupChatClientMessage;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") return;
          message = parsed as GroupChatClientMessage;
        } catch {
          this.options.log?.("ignoring malformed group server message");
          return;
        }
        if ((message.type === "message.accepted" || message.type === "message.suppressed") && typeof message.clientMessageId === "string") {
          const pending = this.pendingMessages.get(message.clientMessageId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingMessages.delete(message.clientMessageId);
            if (message.type === "message.suppressed") {
              pending.resolve({ messageId: "", seq: 0, suppressed: true });
            } else if (typeof message.messageId === "string" && Number.isSafeInteger(Number(message.seq))) {
              pending.resolve({ messageId: message.messageId, seq: Number(message.seq) });
            } else {
              pending.reject(new Error("Platform returned an invalid message acceptance"));
            }
          }
          return;
        }
        if (message.type === "hello.ok") {
          connected = true;
          helloResolve?.();
          onConnected?.();
          return;
        }
        if (message.type === "error" && !connected) {
          helloReject?.(new Error(typeof message.message === "string" ? message.message : "group server rejected hello"));
          return;
        }
        if (connected) void onMessage(message).catch((error) => this.options.log?.(`message handler failed: ${String(error)}`));
      });
      socket.addEventListener("error", () => {
        if (!connected) helloReject?.(new Error("group server websocket error"));
      });
      socket.addEventListener("close", () => {
        signal.removeEventListener("abort", abort);
        if (this.socket === socket) this.socket = undefined;
        this.rejectPending(new Error("group server connection closed"));
        onDisconnected?.();
        closeResolve?.();
        if (!connected && !settled) reject(new Error("group server disconnected before hello"));
      });

      void hello
        .then(async () => {
          await closed;
          if (!settled) {
            settled = true;
            resolve();
          }
        })
        .catch((error: unknown) => {
          if (!settled) {
            settled = true;
            socket.close(4003, "hello failed");
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingMessages) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingMessages.delete(id);
    }
  }
}
