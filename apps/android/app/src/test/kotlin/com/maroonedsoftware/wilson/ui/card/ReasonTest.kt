package com.maroonedsoftware.wilson.ui.card

import com.maroonedsoftware.wilson.sdk.models.CardPullRequest
import com.maroonedsoftware.wilson.sdk.models.CardPullRequestState
import com.maroonedsoftware.wilson.sdk.models.MergeResult
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReasonTest {
    @Test
    fun theDetailedReasonWins() =
        assertEquals("dependency 0002 is not merged", reasonIn(Json.parseToJsonElement("""{"message":"Conflict","details":{"reason":"dependency 0002 is not merged"}}""")))

    @Test
    fun theMessageIsTheFallback() = assertEquals("Conflict", reasonIn(Json.parseToJsonElement("""{"message":"Conflict"}""")))

    @Test
    fun aBodyThatIsNotJsonHasNone() = assertNull(reasonIn(null))

    @Test
    fun aGatewayAnswerSaysTheServerWasNotReached() = assertEquals(true, "could not be reached" in noReason(502))

    @Test
    fun anyOtherBareStatusIsReportedAsIs() = assertEquals("The server answered 500.", noReason(500))

    @Test
    fun theFeedNamesItsCard() {
        assertEquals("0007", feedCardId("""{"id":1,"correlationId":"0007"}"""))
        assertNull(feedCardId("nonsense"))
    }
}

class MergeMessageTest {
    @Test
    fun aLandedMergeNamesItsCommit() = assertEquals("Landed on main as abcdef12.", mergeMessage(MergeOutcome.Landed("abcdef1234567")))

    @Test
    fun aRefusalIsTheServersOwn() = assertEquals("tests failed", mergeMessage(MergeOutcome.Refused("tests failed")))

    @Test
    fun aLostAnswerNeverClaimsEitherWay() = assertEquals(true, "may still have landed" in mergeMessage(MergeOutcome.Unknown))

    @Test
    fun anOpenedPullRequestSaysSo() =
        assertEquals(true, mergeMessage(MergeOutcome.OpenedPullRequest(42)).startsWith("Opened pull request #42."))
}

class MergeOutcomeTest {
    private fun result(merged: Boolean, commit: String? = null, reason: String? = null, pullRequest: CardPullRequest? = null) =
        MergeResult(
            id = "0001", title = "t", stage = "ready", dependsOn = emptyList(), needsHuman = false, body = "", sections = emptyMap(),
            merged = merged, commit = commit, reason = reason, pullRequest = pullRequest,
        )

    private fun pullRequest(state: CardPullRequestState) = CardPullRequest(number = 42, url = "https://github.com/o/r/pull/42", state = state)

    @Test
    fun aMergeThatLandedIsLanded() = assertEquals(MergeOutcome.Landed("abc"), mergeOutcomeOf(result(true, commit = "abc")))

    @Test
    fun openingAPullRequestIsNotARefusal() =
        assertEquals(MergeOutcome.OpenedPullRequest(42), mergeOutcomeOf(result(false, reason = "opened pull request #42", pullRequest = pullRequest(CardPullRequestState.OPEN))))

    @Test
    fun aClosedPullRequestLeavesTheRefusalStanding() =
        assertEquals(MergeOutcome.Refused("No."), mergeOutcomeOf(result(false, reason = "No.", pullRequest = pullRequest(CardPullRequestState.CLOSED))))

    @Test
    fun aPullRequestTakesMergesPlaceUntilItIsClosed() {
        assertEquals("PR #42 open", pullRequestLabel(pullRequest(CardPullRequestState.OPEN)))
        assertEquals("PR #42 merged", pullRequestLabel(pullRequest(CardPullRequestState.MERGED)))
        assertNull(pullRequestLabel(pullRequest(CardPullRequestState.CLOSED)))
        assertNull(pullRequestLabel(null))
    }
}
