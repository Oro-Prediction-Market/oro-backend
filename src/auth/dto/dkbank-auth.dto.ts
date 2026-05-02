import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, Length } from "class-validator";

export class DKBankAuthDto {
  @ApiProperty({
    description: "CID (11-digit national ID)",
    example: "11000000000",
    minLength: 11,
    maxLength: 11,
  })
  @IsString()
  @IsNotEmpty()
  @Length(11, 11)
  cid: string;
}
