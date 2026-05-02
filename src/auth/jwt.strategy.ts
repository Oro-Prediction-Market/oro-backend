import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly redis: RedisService,
  ) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("JWT_SECRET environment variable must be set");
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: {
    sub: string;
    isAdmin: boolean;
    jti?: string;
    exp?: number;
  }) {
    // Check revocation blacklist — tokens revoked via logout are blocked immediately
    if (payload.jti) {
      const revoked = await this.redis.get(`jwt:blacklist:${payload.jti}`);
      if (revoked) throw new UnauthorizedException("Token has been revoked");
    }

    // Always re-check DB so revoked admin rights take effect immediately
    const user = await this.userRepo.findOneBy({ id: payload.sub });
    if (!user) throw new UnauthorizedException("Session invalid - user not found");

    return {
      userId: user.id,
      isAdmin: user.isAdmin,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
