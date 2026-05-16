export function sma(values, period, index = values.length - 1) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += values[i];
  return sum / period;
}

export function stdev(values, period, index = values.length - 1) {
  const mean = sma(values, period, index);
  if (mean == null) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += (values[i] - mean) ** 2;
  return Math.sqrt(sum / period);
}

export function rsi(values, period, index = values.length - 1) {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function atr(candles, period, index = candles.length - 1) {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const prevClose = candles[i - 1]?.close ?? candles[i].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
    sum += tr;
  }
  return sum / period;
}

export function highest(values, period, index = values.length - 1) {
  if (index < period) return null;
  let max = -Infinity;
  for (let i = index - period; i < index; i++) max = Math.max(max, values[i]);
  return max;
}

export function slope(values, period, index = values.length - 1) {
  if (index < period) return null;
  return values[index] - values[index - period];
}
