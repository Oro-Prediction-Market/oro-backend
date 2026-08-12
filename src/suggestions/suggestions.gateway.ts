import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from "@nestjs/websockets";
import { Injectable, Logger } from "@nestjs/common";
import { Server } from "socket.io";
import { MarketCategory } from "../entities/market.entity";

/** A vote landed — every open orbit updates this suggestion's count in place. */
export interface SuggestionVotedPayload {
  id: string;
  votes: number;
}

/** A suggestion was just approved and has joined the orbit. */
export interface SuggestionAddedPayload {
  id: string;
  title: string;
  description: string | null;
  category: MarketCategory;
  votes: number;
  creator: string;
  createdAt: string;
  marketId: string | null;
}

/**
 * Live updates for the Oracle Orbit.
 *
 * Everyone in the namespace sees every suggestion, so there are no rooms to
 * join — the orbit is a single shared view. Broadcasts cross pods via the
 * Redis socket.io adapter installed in main.ts.
 */
@Injectable()
@WebSocketGateway({
  cors: { origin: "*" },
  namespace: "/suggestions",
})
export class SuggestionsGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SuggestionsGateway.name);

  afterInit() {
    this.logger.log("SuggestionsGateway initialised");
  }

  emitVoted(payload: SuggestionVotedPayload): void {
    if (!this.server) return;
    this.server.emit("suggestion_voted", payload);
  }

  emitAdded(payload: SuggestionAddedPayload): void {
    if (!this.server) return;
    this.server.emit("suggestion_added", payload);
  }
}
