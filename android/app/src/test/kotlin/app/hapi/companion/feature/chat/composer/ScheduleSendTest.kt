package app.hapi.companion.feature.chat.composer

import kotlin.test.*

class ScheduleSendTest {
    @Test fun `presets use send time and survive persistence`() {
        val preset = SendSchedule(delayMinutes = 5)
        assertEquals(preset, SendSchedule.decode(preset.encode()))
        assertEquals(310_000L, preset.resolve(10_000))
        assertEquals(320_000L, preset.resolve(20_000))
        val absolute = SendSchedule(epochMs = 123456789L)
        assertEquals(absolute, SendSchedule.decode(absolute.encode()))
        assertEquals(123456789L, absolute.resolve(10_000))
    }
    @Test fun `bounds match web grace and seven day cap`() {
        val now = 100_000L
        assertTrue(SendSchedule.valid(now - 30_000, now))
        assertFalse(SendSchedule.valid(now - 30_001, now))
        assertTrue(SendSchedule.valid(now + 604_800_000, now))
        assertFalse(SendSchedule.valid(now + 604_800_001, now))
        assertNull(SendSchedule.decode("preset:999"))
        assertNull(SendSchedule.decode("at:invalid"))
    }
}
