package com.maroonedsoftware.wilson.ui.stats

import com.maroonedsoftware.wilson.sdk.models.ProjectGateKickback
import com.maroonedsoftware.wilson.sdk.models.ProjectGateKickbackReason
import com.maroonedsoftware.wilson.sdk.models.ProjectGateStats
import com.maroonedsoftware.wilson.sdk.models.ProjectStats
import com.maroonedsoftware.wilson.sdk.models.ProjectStatsQuery
import com.maroonedsoftware.wilson.sdk.runtime.SdkJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

private const val WINDOW = """"since":"2026-10-09T00:00:00Z","until":"2026-11-07T12:00:00Z","zone":"Europe/London""""

/** A window with 10 attempts, 8 passed, of which the gates say 3 were a `revise`. */
private val STATS: ProjectStats = SdkJson.decodeFromString(
    """
    {$WINDOW,
     "total":{"attempts":10,"passed":8,"failed":2,"interrupted":1,"inputTokens":2000000,"cachedInputTokens":1500000,"outputTokens":123456,"cards":4},
     "stages":[
       {"stage":"implementing","attempts":6,"passed":5,"failed":1,"interrupted":1,"inputTokens":1,"cachedInputTokens":0,"outputTokens":1,"cards":4},
       {"stage":"review","attempts":4,"passed":3,"failed":1,"interrupted":0,"inputTokens":1,"cachedInputTokens":0,"outputTokens":1,"cards":0}
     ],
     "days":[{"date":"2026-11-07","attempts":1,"passed":1,"failed":0,"interrupted":0,"inputTokens":1,"cachedInputTokens":0,"outputTokens":5}],
     "topCards":[],
     "conversations":[
       {"kind":"planning","turns":2,"cards":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":1500},
       {"kind":"review","turns":0,"cards":0,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0}
     ]}
    """,
)

private val GATES: ProjectGateStats = SdkJson.decodeFromString(
    """
    {$WINDOW,
     "kickbacks":[
       {"stage":"review","reason":"revise","count":3,"matched":0},
       {"stage":"testing","step":"verify","reason":"verifier","count":2,"matched":1}
     ],
     "failures":[{"failureClass":"verifier","count":2,"matched":1}],
     "revised":[{"stage":"review","count":3}],
     "challenge":{"upheld":1,"overturned":0},
     "questions":{"asked":1,"answered":1},
     "rules":[],
     "difficulties":[],
     "loopStops":0,
     "touchpoints":[{"cause":"question","count":1}],
     "firstPass":{"reached":4,"firstPass":3},
     "matched":1}
    """,
)

class StatsFiguresTest {
    @Test
    fun thePassRateSubtractsTheGatesRevises() {
        val passed = headlineTiles(STATS, GATES)[2]
        assertEquals(Tile("Attempts passed", "50%", "5 of 10 attempts, 3 asked for changes"), passed)
    }

    @Test
    fun aStagesPassRateSubtractsOnlyItsOwnRevises() {
        assertEquals(83L, stagePassRate(STATS.stages[0], GATES.revised))
        assertEquals(0L, stagePassRate(STATS.stages[1], GATES.revised))
    }

    @Test
    fun revisesReadAMomentLaterNeverGoBelowZero() = assertEquals(0L, passedOutright(2, 3))

    @Test
    fun noAttemptsIsADashNotZero() {
        assertNull(percentOf(0, 0))
        assertEquals("–", percent(percentOf(0, 0)))
        assertEquals("–", perCard(4, 0))
    }

    @Test
    fun theHeadlineTilesAreWebs() {
        val tiles = headlineTiles(STATS, GATES)
        assertEquals(Tile("Output tokens", "123.5K", "plus 1.5K in planning and review"), tiles[0])
        assertEquals(Tile("Input tokens", "2M", "75% cached"), tiles[1])
        assertEquals(Tile("Cards", "4", "2.5 attempts each, 1 interrupted"), tiles[3])
    }

    @Test
    fun theGateTilesCountQuestionsAskedAndAnswered() {
        val tiles = gateTiles(GATES)
        assertEquals(Tile("First pass", "75%", "3 of 4 cards reaching ready, no retries spent"), tiles[0])
        assertEquals(Tile("Kickbacks", "5", "challenge upheld 1, overturned 0"), tiles[1])
        assertEquals(Tile("People pulled in", "1", "1 question, 1 answered"), tiles[2])
        assertEquals(Tile("Loop stops", "0"), tiles[3])
    }

    @Test
    fun kickbacksAreNamedByWhoJudged() {
        assertEquals("Asked for changes", kickbackLabel(GATES.kickbacks[0]))
        assertEquals("Verify rejected it", kickbackLabel(GATES.kickbacks[1]))
        assertEquals("Review upheld a revise", kickbackLabel(ProjectGateKickback("review", "review", ProjectGateKickbackReason.REVISE, 1, 0)))
        assertEquals("2 (1 matched)", countWithMatched(2, 1))
        assertEquals("2", countWithMatched(2, 0))
    }

    @Test
    fun tokensAreCompactAsWebsIntl() {
        assertEquals("0", compactTokens(0))
        assertEquals("999", compactTokens(999))
        assertEquals("1.2K", compactTokens(1234))
        assertEquals("1M", compactTokens(999_999))
        assertEquals("1.2M", compactTokens(1_234_567))
    }

    @Test
    fun theAxisEndsOnACleanNumber() {
        assertEquals(1.0, axisTop(0), 0.0)
        assertEquals(250.0, axisTop(210), 0.0)
        assertEquals(10_000.0, axisTop(6_000), 0.0)
    }

    @Test
    fun daysReadAsWebsLabels() = assertEquals("7 Nov", dayLabel("2026-11-07"))

    @Test
    fun anEmptyWindowSaysSo() {
        val idle = STATS.copy(total = STATS.total.copy(attempts = 0, interrupted = 0), conversations = STATS.conversations.map { it.copy(turns = 0) })
        assertFalse(hasRun(idle))
        assertTrue(hasRun(STATS))
    }
}

class StatsWindowTest {
    private fun figures(days: Long) = StatsFigures(days, STATS, GATES)

    @Test
    fun itStartsAtThirtyOfSevenThirtyOrNinety() {
        assertEquals(listOf(7L, 30L, 90L), STATS_WINDOWS)
        assertEquals(30L, StatsState().days)
        assertTrue(StatsState().loading)
    }

    @Test
    fun choosingAWindowKeepsThePreviousFigures() {
        val shown = StatsState().loaded(figures(30))
        val choosing = shown.choosing(7)
        assertEquals(7L, choosing.days)
        assertTrue(choosing.loading)
        assertSame(shown.figures, choosing.figures)
    }

    @Test
    fun aReadForAWindowNoLongerChosenIsDropped() {
        val choosing = StatsState().loaded(figures(30)).choosing(90)
        assertSame(choosing, choosing.loaded(figures(7)))
        assertSame(choosing, choosing.failed(7, "late"))
        assertEquals(90L, choosing.loaded(figures(90)).figures?.days)
    }

    @Test
    fun aRefusalKeepsTheFiguresAndIsShownInTheApisWords() {
        val failed = StatsState().loaded(figures(30)).choosing(7).failed(7, "project not found")
        assertEquals("project not found", failed.error)
        assertFalse(failed.loading)
        assertEquals(30L, failed.figures?.days)
        assertNull(failed.loaded(figures(7)).error)
    }

    @Test
    fun bothReadsAskForTheSameWindowAndRunTogether() = runTest {
        val asked = mutableListOf<ProjectStatsQuery>()
        val statsStarted = CompletableDeferred<Unit>()
        val gatesStarted = CompletableDeferred<Unit>()
        val read = readStats(
            90,
            { query ->
                asked += query
                statsStarted.complete(Unit)
                // Waits for the other: a read that ran them one after the other would never finish.
                gatesStarted.await()
                STATS
            },
            { query ->
                asked += query
                gatesStarted.complete(Unit)
                statsStarted.await()
                GATES
            },
        )
        assertEquals(listOf(ProjectStatsQuery(90), ProjectStatsQuery(90)), asked)
        assertEquals(90L, read.days)
        assertSame(STATS, read.stats)
        assertSame(GATES, read.gates)
    }
}
