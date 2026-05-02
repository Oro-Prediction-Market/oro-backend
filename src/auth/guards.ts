import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Reflector } from "@nestjs/core";

export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private reflector: Reflector) {
    super();
  }
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      // Still try to decode the token so req.user is populated when a valid
      // JWT is present on a public route (e.g. POST /auth/dkbank).
      // If the token is absent or invalid we just let the request through anyway.
      const req = context.switchToHttp().getRequest();
      const authHeader: string | undefined = req.headers["authorization"];
      if (authHeader?.startsWith("Bearer ")) {
        return super.canActivate(context) as any;
      }
      return true;
    }
    return super.canActivate(context);
  }

  // Override handleRequest so that token errors on public routes are silently
  // ignored (req.user stays undefined) rather than throwing 401.
  handleRequest(err: any, user: any, _info: any, context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return user ?? null; // null is fine — public route will proceed without req.user
    }
    if (err || !user) throw err || new UnauthorizedException();
    return user;
  }
}

@Injectable()
export class AdminGuard {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req.user?.isAdmin) throw new UnauthorizedException("Admin only");
    return true;
  }
}
