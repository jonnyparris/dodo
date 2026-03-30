/**
 * Adapter that wraps the Agent SDK's Connection (partyserver WebSocket)
 * to work as a Cap'n Web RpcTransport.
 *
 * Usage:
 *   const transport = new AgentConnectionTransport(connection);
 *   const session = new RpcSession(transport, localMain);
 *
 * The CodingAgent's onMessage handler should call transport.deliver(message)
 * for each incoming text message.
 */

import type { RpcTransport } from "capnweb";
import type { Connection } from "agents";

export class AgentConnectionTransport implements RpcTransport {
  private messageQueue: string[] = [];
  private messageResolve?: (msg: string) => void;
  private messageReject?: (err: Error) => void;
  private closed = false;

  constructor(private connection: Connection) {}

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error("Transport closed");
    this.connection.send(message);
  }

  async receive(): Promise<string> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }
    if (this.closed) {
      throw new Error("Transport closed");
    }
    return new Promise<string>((resolve, reject) => {
      this.messageResolve = resolve;
      this.messageReject = reject;
    });
  }

  /**
   * Called by the CodingAgent's onMessage handler to feed incoming
   * WebSocket messages into the transport's receive() pipeline.
   */
  deliver(message: string): void {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = undefined;
      this.messageReject = undefined;
      resolve(message);
    } else {
      this.messageQueue.push(message);
    }
  }

  /**
   * Called when the connection closes. Rejects any pending receive().
   */
  close(): void {
    this.closed = true;
    if (this.messageReject) {
      const reject = this.messageReject;
      this.messageResolve = undefined;
      this.messageReject = undefined;
      reject(new Error("Transport closed"));
    }
  }

  abort(reason: unknown): void {
    this.closed = true;
    const message = reason instanceof Error ? reason.message : "Transport aborted";
    if (this.messageReject) {
      const reject = this.messageReject;
      this.messageResolve = undefined;
      this.messageReject = undefined;
      reject(new Error(message));
    }
  }
}
