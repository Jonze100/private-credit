'use client';

interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  accent?: 'purple' | 'green' | 'white';
}

export function MetricCard({ label, value, sub, accent = 'white' }: MetricCardProps) {
  const accentClass =
    accent === 'purple'
      ? 'text-[#9945FF]'
      : accent === 'green'
        ? 'text-[#14F195]'
        : 'text-white';

  return (
    <div className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono ${accentClass}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}
