import { Injectable } from "@nestjs/common";
import { Subject, Observable, filter } from "rxjs";

export interface SseEvent {
  userId: string;
  type: string; // e.g. 'balance:updated', 'market:updated'
  data?: Record<string, any>;
}

@Injectable()
export class SseService {
  private readonly events$ = new Subject<SseEvent>();

  /** Emit an event to a specific user */
  emit(userId: string, type: string, data?: Record<string, any>): void {
    this.events$.next({ userId, type, data });
  }

  /** Emit an event to ALL connected users (broadcast) */
  broadcast(type: string, data?: Record<string, any>): void {
    this.events$.next({ userId: "*", type, data });
  }

  /** Get observable filtered for a specific user */
  forUser(userId: string): Observable<SseEvent> {
    return this.events$.pipe(
      filter((e) => e.userId === userId || e.userId === "*"),
    );
  }
}
