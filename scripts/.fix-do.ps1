$p = 'd:\Projects\Active\Game\OpenFrontIO\src\core\CloudflareDurableObjects.ts'
$raw = [System.IO.File]::ReadAllText($p)
$n = "`r`n"

# 1. The class does not implement the full HostingAdapter surface yet.
$raw = $raw.Replace(
  'export class CloudflareDurableObject implements HostingAdapter {',
  'export class CloudflareDurableObject {')

# 2. this.matchID is string | null; look up by the per-request room code and
#    guard instead of asserting non-null.
$raw = $raw.Replace(
  "    const match = this.state.get(this.matchID)!;$n    const playerSession: PlayerSession = {",
  "    const match = this.state.get(code);$n    if (!match) return;$n    const playerSession: PlayerSession = {")

$raw = $raw.Replace(
  "    if (!this.matchID) return;$n    const match = this.state.get(this.matchID)!;",
  "    if (!this.matchID) return;$n    const match = this.state.get(this.matchID);$n    if (!match) return;")

foreach ($method in @('handleCreateArmy', 'handleBuildFactory', 'handleCreateAirWing', 'handleAssignAirMission', 'handleAirliftArmy')) {
  $raw = $raw.Replace(
    "  private $method(code: string, payload: any, player: PlayerSession): CommandResult {$n    const match = this.state.get(this.matchID)!;",
    "  private $method(code: string, payload: any, player: PlayerSession): CommandResult {$n    const match = this.state.get(code);$n    if (!match) return { success: false, failureReason: ""Match not found"", tick: 0 };")
}

# handleLeaveMatch: take the match for the room code that actually changed.
$raw = $raw.Replace(
  "  private handleLeaveMatch(code: string, playerID: string): void {$n    const match = this.state.get(this.matchID);",
  "  private handleLeaveMatch(code: string, playerID: string): void {$n    const match = this.state.get(code);")

[System.IO.File]::WriteAllText($p, $raw)
Write-Output 'DONE'
