import Link from 'next/link'

export function Footer() {
  return (
    <footer className="bg-[#FAF8F5] dark:bg-[#0F0A0A] border-t border-[#F2EDE8] dark:border-[#2A1A1A] mt-20 mb-16 md:mb-0">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">

        {/* Main row: logo left, links right */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10">

          {/* Brand */}
          <div className="shrink-0">
            <Link href="/" className="inline-block">
              <span className="text-[#8B1A1A] font-extrabold text-xl tracking-tight">UNITY</span>
            </Link>
            <p className="text-xs text-[#9B8B85] mt-3 leading-relaxed max-w-[180px] uppercase tracking-[0.05em]">
              Rent what you need.<br />Earn from what you have.
            </p>
          </div>

          {/* Link groups */}
          <div className="flex flex-wrap gap-x-16 gap-y-8">

            {/* Platform */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Platform</h4>
              <ul className="space-y-2.5">
                <li><Link href="/how-it-works" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">How It Works</Link></li>
                <li><Link href="/listings" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Browse Items</Link></li>
                <li><Link href="/pricing" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Pricing</Link></li>
                <li><Link href="/trust-and-safety" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Trust &amp; Safety</Link></li>
              </ul>
            </div>

            {/* Company */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Company</h4>
              <ul className="space-y-2.5">
                <li><Link href="/about" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">About</Link></li>
                <li><Link href="/ambassadors" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Ambassadors</Link></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Legal</h4>
              <ul className="space-y-2.5">
                <li><Link href="/terms" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Terms &amp; Conditions</Link></li>
                <li><Link href="/privacy" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Privacy Policy</Link></li>
                <li><Link href="/popia" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">POPIA Policy</Link></li>
              </ul>
            </div>

          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[#F2EDE8] dark:border-[#2A1A1A] mt-10 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-[#9B8B85] uppercase tracking-[0.06em]">© {new Date().getFullYear()} Unity. All rights reserved.</p>
          <div className="flex items-center gap-5 text-[#9B8B85]">
            <a href="#" aria-label="Instagram" className="hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
              </svg>
            </a>
            <a href="#" aria-label="TikTok" className="hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.17 8.17 0 004.77 1.52V6.76a4.85 4.85 0 01-1-.07z"/>
              </svg>
            </a>
            <a href="#" aria-label="YouTube" className="hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.5 6.19a3.02 3.02 0 00-2.12-2.14C19.55 3.5 12 3.5 12 3.5s-7.55 0-9.38.55A3.02 3.02 0 00.5 6.19C0 8.04 0 12 0 12s0 3.96.5 5.81a3.02 3.02 0 002.12 2.14C4.45 20.5 12 20.5 12 20.5s7.55 0 9.38-.55a3.02 3.02 0 002.12-2.14C24 15.96 24 12 24 12s0-3.96-.5-5.81zM9.75 15.02V8.98L15.5 12l-5.75 3.02z"/>
              </svg>
            </a>
            <a href="#" aria-label="Facebook" className="hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
              </svg>
            </a>
          </div>
        </div>

      </div>
    </footer>
  )
}
