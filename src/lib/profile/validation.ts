import { z } from 'zod'

export const countryUpdateSchema = z.object({
  country_id: z.string().min(2).max(8),
})

export const displayNameUpdateSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
})
