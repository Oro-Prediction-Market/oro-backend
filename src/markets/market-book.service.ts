import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Market, MarketStatus } from "../entities/market.entity";
import { MarketBook } from "../entities/market-book.entity";
import { OutcomeBook } from "../entities/outcome-book.entity";
import { Position } from "../entities/position.entity";
import { BTN_CURRENCY } from "../entities/transaction.entity";
import { ensureOutcomeBooks, btnMinStakeFor } from "./market-book.util";

const SUPPORTED_CURRENCIES = new Set([BTN_CURRENCY, "USDT"]);

export interface BookView {
  id: string;
  marketId: string;
  currency: string;
  totalPool: string;
  houseEdgePct: string;
  minStake: string;
  status: string;
  isEnabled: boolean;
  /** Whether anyone has staked. Once true, terms are frozen. */
  hasPositions: boolean;
}

@Injectable()
export class MarketBookService {
  private readonly logger = new Logger(MarketBookService.name);

  constructor(
    @InjectRepository(MarketBook)
    private readonly bookRepo: Repository<MarketBook>,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async listBooks(marketId: string): Promise<BookView[]> {
    const books = await this.bookRepo.find({ where: { marketId } });
    return Promise.all(books.map((b) => this.toView(b)));
  }

  async openBook(
    marketId: string,
    input: { currency: string; houseEdgePct: number; minStake: number },
  ): Promise<BookView> {
    const currency = String(input.currency ?? "").toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) {
      throw new BadRequestException(
        `Unsupported currency "${input.currency}". Supported: ${[...SUPPORTED_CURRENCIES].join(", ")}`,
      );
    }

    const market = await this.marketRepo.findOne({
      where: { id: marketId },
      relations: ["outcomes"],
    });
    if (!market) throw new NotFoundException("Market not found");

    // Opening a book on a market that has already resolved would create a pool
    // nobody can stake into and settlement has already passed over.
    if (
      market.status === MarketStatus.SETTLED ||
      market.status === MarketStatus.RESOLVED
    ) {
      throw new BadRequestException(
        "Cannot open a book on a market that has already resolved",
      );
    }
    if (!market.outcomes?.length) {
      throw new BadRequestException("Market has no outcomes");
    }

    const existing = await this.bookRepo.findOneBy({ marketId, currency });
    if (existing) {
      throw new ConflictException(
        `This market already has a ${currency} book`,
      );
    }

    this.assertTerms(input.houseEdgePct, input.minStake);

    const book = await this.dataSource.transaction(async (em) => {
      const created = await em.save(
        MarketBook,
        em.create(MarketBook, {
          marketId,
          currency,
          totalPool: 0,
          houseEdgePct: input.houseEdgePct,
          minStake: input.minStake,
          isEnabled: true,
        }),
      );
      // Without these the book cannot price anything.
      await ensureOutcomeBooks(em, market, currency);
      return created;
    });

    this.logger.log(
      `[Books] Opened ${currency} book on market ${marketId} ` +
        `(edge ${input.houseEdgePct}%, min ${input.minStake})`,
    );
    return this.toView(book);
  }

  /**
   * Change a book's terms.
   *
   * Refused once anyone has staked. Someone who bet at an 8% cut agreed to an
   * 8% cut, and moving it afterwards changes the payout they were quoted.
   */
  async updateTerms(
    bookId: string,
    input: { houseEdgePct?: number; minStake?: number },
  ): Promise<BookView> {
    const book = await this.requireBook(bookId);
    if (await this.hasPositions(book)) {
      throw new BadRequestException(
        "This book already has stakes — its terms cannot be changed",
      );
    }
    const edge = input.houseEdgePct ?? Number(book.houseEdgePct);
    const min = input.minStake ?? Number(book.minStake);
    this.assertTerms(edge, min);

    await this.bookRepo.update(
      { id: book.id },
      { houseEdgePct: edge, minStake: min },
    );
    return this.toView((await this.bookRepo.findOneBy({ id: book.id }))!);
  }

  async setEnabled(bookId: string, enabled: boolean): Promise<BookView> {
    const book = await this.requireBook(bookId);
    await this.bookRepo.update({ id: book.id }, { isEnabled: enabled });
    this.logger.log(
      `[Books] ${enabled ? "Enabled" : "Disabled"} ${book.currency} book on market ${book.marketId}`,
    );
    return this.toView((await this.bookRepo.findOneBy({ id: book.id }))!);
  }

  private assertTerms(houseEdgePct: number, minStake: number): void {
    if (!Number.isFinite(houseEdgePct) || houseEdgePct < 0 || houseEdgePct > 50) {
      throw new BadRequestException("House edge must be between 0 and 50%");
    }
    if (!Number.isFinite(minStake) || minStake <= 0) {
      throw new BadRequestException("Minimum stake must be greater than zero");
    }
  }

  private async requireBook(bookId: string): Promise<MarketBook> {
    const book = await this.bookRepo.findOneBy({ id: bookId });
    if (!book) throw new NotFoundException("Book not found");
    return book;
  }

  private async hasPositions(book: MarketBook): Promise<boolean> {
    const count = await this.positionRepo.count({
      where: { marketId: book.marketId, currency: book.currency },
    });
    return count > 0;
  }

  private async toView(book: MarketBook): Promise<BookView> {
    return {
      id: book.id,
      marketId: book.marketId,
      currency: book.currency,
      totalPool: String(book.totalPool),
      houseEdgePct: String(book.houseEdgePct),
      minStake: String(book.minStake),
      status: book.status,
      isEnabled: book.isEnabled,
      hasPositions: await this.hasPositions(book),
    };
  }

  /** The default minimum a BTN book would get, for pre-filling the admin form. */
  suggestedBtnMinStake(market: Pick<Market, "externalSource">): number {
    return btnMinStakeFor(market);
  }
}
