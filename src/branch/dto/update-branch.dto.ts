import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const isPresent = (_object: unknown, value: unknown): boolean =>
  value !== undefined;

export class UpdateBranchDto {
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  timezone?: string;
}
