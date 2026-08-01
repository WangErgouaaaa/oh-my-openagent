import { randomBytes } from "node:crypto"

const LOW_48_BITS = (1n << 48n) - 1n
let lastTimestamp = 0
let counter = 0

function generateAscendingId(prefix: "msg" | "prt"): string {
  const timestamp = Date.now()
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }

  const encodedTime = (BigInt(timestamp) * 0x1000n + BigInt(++counter)) & LOW_48_BITS
  return `${prefix}_${encodedTime.toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`
}

export function generateMessageId(): string {
  return generateAscendingId("msg")
}

export function generatePartId(): string {
  return generateAscendingId("prt")
}
