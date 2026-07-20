'use client'

import { useState } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import {
  ANALYTICS_BOOKING_VOLUME,
  ANALYTICS_CATEGORIES,
  ANALYTICS_TOP_MERCHANTS,
  ANALYTICS_CITIES,
} from '@/lib/mock/admin-data'

// ─── Types ────────────────────────────────────────────────────────────────────

type Range = 'Weekly' | 'Monthly' | 'All time'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtR(n: number) {
  return `R${n.toLocaleString('en-ZA')}`
}

// Slice booking volume data per selected range
function sliceVolume(range: Range) {
  if (range === 'Weekly')   return ANALYTICS_BOOKING_VOLUME.slice(-4)
  if (range === 'Monthly')  return ANALYTICS_BOOKING_VOLUME.slice(-8)
  return ANALYTICS_BOOKING_VOLUME
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-3 shadow-lg text-sm">
        <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">{label}</p>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {payload.map((p: any) => (
          <p key={p.name} style={{ color: p.color }}>
            {p.name}: {p.name === 'revenue' ? fmtR(p.value) : p.value}
          </p>
        ))}
      </div>
    )
  }
  return null
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminAnalyticsPage() {
  const [range, setRange] = useState<Range>('All time')

  const volumeData = sliceVolume(range)
  const sortedCategories = [...ANALYTICS_CATEGORIES].sort((a, b) => b.bookings - a.bookings)
  const maxCityBookings = ANALYTICS_CITIES[0].bookings // Johannesburg is first and largest

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] space-y-8">

      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            PLATFORM ANALYTICS
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
            ANALYTICS
          </h1>
        </div>

        {/* Date Range Selector */}
        <div className="flex items-center gap-1 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-1">
          {(['Weekly', 'Monthly', 'All time'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] transition-colors ${
                range === r
                  ? 'bg-[#8B1A1A] text-white'
                  : 'text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* ── ROW 1: Booking Volume Chart (full width) ── */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
        <div className="mb-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            Trend
          </p>
          <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">
            Booking Volume &amp; Revenue
          </h2>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={volumeData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F2EDE8" />
            <XAxis
              dataKey="period"
              tick={{ fontSize: 11, fill: '#9B8B85' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: '#9B8B85' }}
              axisLine={false}
              tickLine={false}
              width={30}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11, fill: '#9B8B85' }}
              axisLine={false}
              tickLine={false}
              width={55}
              tickFormatter={(v) => `R${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }}
              formatter={(value) => (
                <span style={{ color: '#9B8B85', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {value}
                </span>
              )}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="bookings"
              stroke="#8B1A1A"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, fill: '#8B1A1A' }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="revenue"
              stroke="#C4511F"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: '#C4511F' }}
              strokeDasharray="4 2"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── ROW 2: Categories + Cities ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* LEFT: Top Categories (horizontal bar chart) */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="mb-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
              Breakdown
            </p>
            <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">
              Top Categories
            </h2>
          </div>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={sortedCategories}
              layout="vertical"
              margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#F2EDE8" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: '#9B8B85' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: '#9B8B85' }}
                axisLine={false}
                tickLine={false}
                width={72}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="bookings" fill="#8B1A1A" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* RIGHT: Revenue by City (progress bars) */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="mb-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
              Geography
            </p>
            <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">
              Revenue by City
            </h2>
          </div>
          <div className="space-y-5">
            {ANALYTICS_CITIES.map((c) => {
              const pct = Math.round((c.bookings / maxCityBookings) * 100)
              return (
                <div key={c.city}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                      {c.city}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                        {c.bookings} bookings
                      </span>
                      <span className="text-sm font-bold text-[#8B1A1A]">
                        {fmtR(c.revenue)}
                      </span>
                    </div>
                  </div>
                  <div className="w-full bg-[#F2EDE8] dark:bg-[#2A1A1A] rounded-full h-2">
                    <div
                      className="h-2 rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: '#8B1A1A' }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── ROW 3: Top Merchants Table ── */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            Leaderboard
          </p>
          <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">
            Top Merchants
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[#FAF8F5] dark:bg-[#0F0A0A]">
              <tr>
                {['Rank', 'Merchant', 'Bookings', 'Revenue'].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
              {ANALYTICS_TOP_MERCHANTS.map((m, i) => (
                <tr
                  key={m.name}
                  className="hover:bg-[#FAF8F5] dark:hover:bg-[#0F0A0A] transition-colors"
                >
                  <td className="px-5 py-4">
                    <span className="text-[11px] font-bold text-[#9B8B85] font-mono tracking-[0.05em]">
                      [{String(i + 1).padStart(2, '0')}]
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                      {m.name}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                      {m.bookings}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <span className="text-sm font-bold text-[#8B1A1A]">
                      {fmtR(m.revenue)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── ROW 4: Key Metrics ── */}
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">
          Key Metrics
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Conversion Rate',       value: '4.2%',      sub: 'Browse → Booking'      },
            { label: 'Avg Rental Value',       value: 'R2,114',    sub: 'Per completed booking' },
            { label: 'Most Popular Category', value: 'Cameras',   sub: '61 bookings this period' },
            { label: 'Peak Booking Day',       value: 'Saturday',  sub: 'Highest transaction volume' },
          ].map(({ label, value, sub }) => (
            <div
              key={label}
              className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5"
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">
                {label}
              </p>
              <p className="text-4xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
                {value}
              </p>
              <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-2">{sub}</p>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}
