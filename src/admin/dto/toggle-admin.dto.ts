import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class ToggleAdminDto {
  @ApiProperty({ description: "Set to true to grant admin, false to revoke" })
  @IsBoolean()
  isAdmin: boolean;
}
