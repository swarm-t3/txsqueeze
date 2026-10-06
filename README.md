# TxSqueeze

Merge many small CSV rows (daily staking rewards, Simple Earn interest, trading-bot fills) into one row per day, week or month, keeping the file's own format so Koinly's importer still reads it. Runs entirely in the browser.

Live: https://swarm-t3.github.io/txsqueeze/

Presets: Binance transaction history (reward operations only), Koinly universal CSV (labeled rows and trades; own-wallet transfers left alone). Any other CSV via column roles.

Why: Koinly bills by transaction count. Koinly support recommends summing rewards per day/week/month to cut it (https://discuss.koinly.io/t/staking-rewards-create-too-many-transactions/15427).

Not tax advice. Not affiliated with Koinly or any exchange.
