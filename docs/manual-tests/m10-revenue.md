# M10 revenue widget check

The revenue tile on the main page shows health, the last refresh, the next refresh, a missed note when a refresh was skipped, and the number of waiting approvals.

On the sample file the total matches the reference sum. A 10 percent drop in one vertical fires one alert. A 9 percent drop fires none. Close the app across two refresh times and open it again: one catch-up refresh runs and the tile says a refresh was missed. Those checks run in CI.
