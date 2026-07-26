param(
  [long]$StartTime = 1672531200000,
  [long]$EndTime = 1782864000000,
  [string[]]$Symbols = @(
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT",
    "BCHUSDT", "TRXUSDT", "SUIUSDT", "INJUSDT", "NEARUSDT",
    "APTUSDT", "DOTUSDT", "UNIUSDT", "AAVEUSDT", "FILUSDT"
  )
)

$ErrorActionPreference = "Stop"
$cacheDirectory = Join-Path $PSScriptRoot "..\.backtest-cache\v3-2-funding"
$resolvedCacheDirectory = [System.IO.Path]::GetFullPath($cacheDirectory)
[System.IO.Directory]::CreateDirectory($resolvedCacheDirectory) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$symbolsToDownload = @($Symbols | ForEach-Object { $_ -split "," })

foreach ($symbol in $symbolsToDownload) {
  $outputPath = Join-Path $resolvedCacheDirectory "$symbol-$StartTime-$EndTime.json"
  $hasValidCache = (Test-Path -LiteralPath $outputPath) -and ((Get-Item -LiteralPath $outputPath).Length -gt 1000)
  if ($hasValidCache) {
    Write-Output "$symbol cached"
    continue
  }

  $records = New-Object System.Collections.Generic.List[object]
  $cursor = $StartTime
  while ($cursor -lt $EndTime) {
    $uri = "https://fapi.binance.com/fapi/v1/fundingRate?symbol=$symbol&startTime=$cursor&endTime=$($EndTime - 1)&limit=1000"
    $response = Invoke-RestMethod -Uri $uri
    $page = New-Object System.Collections.Generic.List[object]
    foreach ($item in $response) {
      $page.Add($item)
    }
    if ($page.Count -eq 0) {
      break
    }
    foreach ($item in $page) {
      $records.Add([pscustomobject][ordered]@{
        symbol = [string]$item.symbol
        fundingRate = [double]$item.fundingRate
        fundingTime = [long]$item.fundingTime
      })
    }
    $nextCursor = [long]$page[-1].fundingTime + 1
    if ($nextCursor -le $cursor) {
      throw "Funding pagination did not advance for $symbol"
    }
    $cursor = $nextCursor
    Start-Sleep -Milliseconds 60
  }

  $deduplicated = @(
    $records |
      Sort-Object fundingTime -Unique |
      Where-Object { $_.fundingTime -ge $StartTime -and $_.fundingTime -lt $EndTime }
  )
  $json = ConvertTo-Json -InputObject $deduplicated -Depth 4 -Compress
  [System.IO.File]::WriteAllText($outputPath, $json, $utf8)
  Write-Output "$symbol $($deduplicated.Count)"
}
