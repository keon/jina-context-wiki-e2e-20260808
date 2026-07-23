export interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
  readonly tone: "green" | "blue" | "red";
}

export function MetricsChart({
  title,
  unit,
  labels,
  series
}: {
  readonly title: string;
  readonly unit: string;
  readonly labels: readonly string[];
  readonly series: readonly ChartSeries[];
}) {
  const width = 1_000;
  const height = 220;
  const padding = { top: 18, right: 18, bottom: 32, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const x = (index: number) =>
    padding.left + (labels.length <= 1 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth);
  const y = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;

  return (
    <section className="metric-chart">
      <div className="metric-chart-heading">
        <h2>{title}</h2>
        <div className="chart-legend">
          {series.map((item) => (
            <span key={item.name} className={`chart-${item.tone}`}>
              {item.name}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}, measured in ${unit}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={padding.top + plotHeight * ratio}
              y2={padding.top + plotHeight * ratio}
              className="chart-grid"
            />
            <text x={padding.left - 10} y={padding.top + plotHeight * ratio + 4} textAnchor="end">
              {formatAxis(max * (1 - ratio))}
            </text>
          </g>
        ))}
        <text className="chart-unit" transform={`translate(14 ${padding.top + plotHeight / 2}) rotate(-90)`}>
          {unit}
        </text>
        {labels.map((label, index) =>
          index % Math.max(1, Math.ceil(labels.length / 8)) === 0 || index === labels.length - 1 ? (
            <text key={`${label}:${index}`} x={x(index)} y={height - 8} textAnchor="middle">
              {label}
            </text>
          ) : null
        )}
        {series.map((item) => (
          <polyline
            key={item.name}
            points={item.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
            className={`chart-line chart-${item.tone}`}
          />
        ))}
      </svg>
    </section>
  );
}

function formatAxis(value: number): string {
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1).replace(/\.0$/, "");
}
