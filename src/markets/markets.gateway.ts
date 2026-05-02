import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";

export interface MarketUpdatedPayload {
  marketId: string;
  totalPool: number;
  outcomes: {
    id: string;
    totalBetAmount: number;
    lmsrProbability: number | null;
    currentOdds: number;
  }[];
}

@WebSocketGateway({
  cors: {
    origin: "*",
  },
  namespace: "/markets",
})
export class MarketsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketsGateway.name);

  afterInit() {
    this.logger.log("MarketsGateway initialised");
  }

  handleConnection(client: Socket) {
    const marketId = client.handshake.query.marketId as string | undefined;
    if (marketId) {
      client.join(`market:${marketId}`);
      this.logger.debug(`Client ${client.id} joined room market:${marketId}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client ${client.id} disconnected`);
  }

  /** Called after every successful bet placement to push live data to viewers. */
  emitMarketUpdated(payload: MarketUpdatedPayload) {
    if (!this.server) {
      this.logger.warn("emitMarketUpdated called before server initialised");
      return;
    }
    this.logger.debug(
      `Broadcasting market_updated for market:${payload.marketId}`,
    );
    this.server
      .to(`market:${payload.marketId}`)
      .emit("market_updated", payload);
  }
}
