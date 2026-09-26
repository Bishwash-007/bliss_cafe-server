export interface CreateItemInputDto {
  name: string;
  price: number;
  description?: string | null;
  isAvailable?: boolean;
  imageUrl?: string | null;
  categoryId?: string | null;
}
