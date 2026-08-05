import { z } from 'zod'

export const countryUpdateSchema = z.object({
  country_id: z.string().min(2).max(8),
})
