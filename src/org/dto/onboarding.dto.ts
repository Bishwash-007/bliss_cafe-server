import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class OnboardingBranchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string | null;
}

export class OnboardingOwnerDto {
  @IsEmail()
  @MaxLength(150)
  email!: string;

  /**
   * Required: the old empty-password fallback hashed `''` and produced a real
   * account whose password was the empty string.
   *
   * bcrypt only considers the first 72 bytes, so a longer password would be
   * silently truncated rather than rejected.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

export class OnboardingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  orgName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
  slug!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  planId?: string;

  /**
   * The branch the café opens with.
   *
   * `IsDefined` is what makes a MISSING branch a 400 rather than a crash
   * further down: `@ValidateNested` alone skips an absent value, and the
   * builder would then read `dto.firstBranch.name` off `undefined`.
   */
  @IsDefined()
  @ValidateNested()
  @Type(() => OnboardingBranchDto)
  firstBranch!: OnboardingBranchDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  defaultTables?: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => OnboardingOwnerDto)
  owner!: OnboardingOwnerDto;
}
