Get-ChildItem src\migrations\*.sql | Sort-Object Name | ForEach-Object {
    Write-Host "Running $($_.Name)..."
    psql "postgres://postgres:postgres123@localhost:5432/sleep_and_journey_test" -f $_.FullName
}
