import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsIn, MinLength, MaxLength } from "class-validator";

export class ClientInquiryDto {
  @ApiProperty({
    description: 'ID type - must be "CID"',
    example: "CID",
    enum: ["CID"],
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(["CID"])
  id_type: "CID";

  @ApiProperty({
    description: "CID number - 11 digits",
    example: "11000000000",
    minLength: 11,
    maxLength: 11,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(11)
  @MaxLength(11)
  id_number: string;
}
