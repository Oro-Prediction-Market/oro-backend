import { Controller, Get, Header, Res } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Response } from "express";
import { Market } from "../entities/market.entity";
import { MarketStatus } from "../entities/market.entity";
import { Public } from "../auth/guards";
import { SkipThrottle } from "@nestjs/throttler";

const PWA_BASE = "https://oro.fun";

const STATIC_URLS: Array<{ loc: string; changefreq: string; priority: string }> =
  [
    { loc: `${PWA_BASE}/`, changefreq: "daily", priority: "1.0" },
    { loc: `${PWA_BASE}/markets`, changefreq: "daily", priority: "0.9" },
    { loc: `${PWA_BASE}/leaderboard`, changefreq: "daily", priority: "0.8" },
    { loc: `${PWA_BASE}/resolved`, changefreq: "weekly", priority: "0.7" },
    { loc: `${PWA_BASE}/terms`, changefreq: "monthly", priority: "0.3" },
    { loc: `${PWA_BASE}/privacy`, changefreq: "monthly", priority: "0.3" },
  ];

@SkipThrottle()
@Controller()
export class SitemapController {
  constructor(
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
  ) {}

  @Get("robots.txt")
  @Public()
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Cache-Control", "public, max-age=86400")
  getRobots(): string {
    return `User-agent: *\nAllow: /\nDisallow: /my-bets\nDisallow: /results\nDisallow: /profile\n\nSitemap: ${PWA_BASE}/sitemap.xml\n`;
  }

  @Get("sitemap.xml")
  @Public()
  @Header("Content-Type", "application/xml; charset=utf-8")
  @Header("Cache-Control", "public, max-age=3600")
  async getSitemap(@Res() res: Response): Promise<void> {
    const markets = await this.marketRepo.find({
      select: ["id", "updatedAt", "status"],
      where: {
        status: In([
          MarketStatus.OPEN,
          MarketStatus.UPCOMING,
          MarketStatus.CLOSED,
          MarketStatus.RESOLVING,
          MarketStatus.RESOLVED,
          MarketStatus.SETTLED,
        ]),
      },
      order: { updatedAt: "DESC" },
    });

    const toDate = (d: Date) => d.toISOString().split("T")[0];
    const today = toDate(new Date());

    const staticEntries = STATIC_URLS.map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`,
    ).join("\n");

    const marketEntries = markets
      .map((m) => {
        const lastmod = toDate(m.updatedAt ?? new Date());
        const priority =
          m.status === MarketStatus.OPEN || m.status === MarketStatus.UPCOMING
            ? "0.8"
            : "0.6";
        return `  <url>\n    <loc>${PWA_BASE}/markets/${m.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>hourly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticEntries}\n${marketEntries}\n</urlset>`;

    res.send(xml);
  }
}
