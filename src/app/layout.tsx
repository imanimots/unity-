import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { Toaster } from 'sonner'
import { ChatWidget } from '@/components/assistant/chat-widget'
import './globals.css'

const plusJakarta = Plus_Jakarta_Sans({
  variable: '--font-plus-jakarta-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Unity — Rent What You Need. Earn From What You Have.',
  description: "South Africa's peer-to-peer rental marketplace. Identity-reviewed users, test-mode checkout, and thousands of items to rent near you.",
  keywords: ['rental', 'peer to peer', 'South Africa', 'rent', 'earn', 'marketplace'],
  openGraph: {
    title: 'Unity — Rent What You Need.',
    description: "South Africa's peer-to-peer rental marketplace, currently in public test.",
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plusJakarta.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#FAF8F5] dark:bg-[#0F0A0A] text-[#1A0A0A] dark:text-[#F5F0ED]">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[#8B1A1A] focus:text-white focus:text-sm focus:font-semibold"
        >
          Skip to main content
        </a>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <ChatWidget />
          <Toaster position="top-center" richColors />
        </ThemeProvider>
      </body>
    </html>
  )
}
