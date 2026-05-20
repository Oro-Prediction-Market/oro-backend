import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional } from "class-validator";

export class BhutanAppAuthDto {
  @ApiProperty({ description: "JWT token issued by BhutanApp on approval" })
  @IsString()
  token: string;

  @ApiProperty({ description: "BhutanApp user identifier (CID extracted from JWT on backend)", example: "11000000000" })
  @IsString()
  externalUserId: string;

  @ApiProperty({ description: "Full name from BhutanApp profile" })
  @IsString()
  fullName: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;
}
