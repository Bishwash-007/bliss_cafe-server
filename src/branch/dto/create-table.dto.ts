import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  label!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  seats?: number;
}
