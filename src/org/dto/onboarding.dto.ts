export class OnboardingDto {
  orgName!: string;
  slug!: string;
  planId?: string;
  firstBranch!: {
    name: string;
    address?: string | null;
  };
  defaultTables?: number;
  owner!: {
    email: string;
    password?: string;
  };
}
