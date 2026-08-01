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
          <div className="flex flex-wrap gap-x-12 gap-y-8">

            {/* Platform */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Platform</h4>
              <ul className="space-y-2.5">
                <li><Link href="/#how-it-works" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">How It Works</Link></li>
                <li><Link href="/listings" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Browse</Link></li>
                <li><Link href="/register?role=merchant" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Become a Merchant</Link></li>
              </ul>
            </div>

            {/* Trust */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Trust</h4>
              <ul className="space-y-2.5">
                <li><Link href="/verification-and-trust" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Verification &amp; Trust</Link></li>
                <li><Link href="/prohibited-items" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Prohibited Items</Link></li>
                <li><Link href="/disputes" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Disputes</Link></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Legal</h4>
              <ul className="space-y-2.5">
                <li><Link href="/terms" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Terms</Link></li>
                <li><Link href="/privacy" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Privacy</Link></li>
                <li><Link href="/popia" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">POPIA</Link></li>
                <li><Link href="/rental-terms" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Rental Terms</Link></li>
                <li><Link href="/payments-and-deposits" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Payments &amp; Deposits</Link></li>
                <li><Link href="/cancellations" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Cancellations</Link></li>
                <li><Link href="/refunds" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Refunds</Link></li>
                <li><Link href="/delivery-and-handover" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Delivery &amp; Handover</Link></li>
              </ul>
            </div>

            {/* Support */}
            <div>
              <h4 className="section-label text-[#9B8B85] mb-4">Support</h4>
              <ul className="space-y-2.5">
                <li><Link href="/contact" className="text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">Contact</Link></li>
              </ul>
            </div>

          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[#F2EDE8] dark:border-[#2A1A1A] mt-10 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-[#9B8B85] uppercase tracking-[0.06em]">© {new Date().getFullYear()} Unity. All rights reserved.</p>
        </div>

      </div>
    </footer>
  )
}
