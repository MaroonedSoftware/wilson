options {
    services: {
        ReviewService: "#modules/review/review.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# A person's review of a card's branch: comments anchored to lines of its diff, kept across reloads and
# across new commits. Separate from `board.ck` so a client built before this file sees no shape change.
#
# Every operation is `mcp: exclude`. A review is a person's judgment of an agent's work, so no agent
# gets a tool for writing one. Writing needs the card to be in `ready`; reading works in any stage, so
# an old review stays readable.

# `stale` is true once the branch has moved past `head`.
contract Review: {
    id: string
    head: string
    base: string
    status: enum(open, changes_requested, approved, superseded)
    stale: boolean
    createdAt: datetime
    verdictAt?: datetime
}

# `line` is where the comment was written, at commit `head`. `location` and `currentLine` say where it is
# now: `outdated` means its line can no longer be told apart in the branch's current diff.
contract ReviewComment: {
    id: string
    reviewId: string
    head: string
    file: string
    side: enum(old, new)
    line: int
    lineText: string
    severity: enum(blocker, concern)
    text: string
    status: enum(open, resolved, sent)
    location: enum(found, outdated)
    currentLine?: int
    createdAt: datetime
}

# `review` is left out for a card nobody has reviewed yet. `comments` holds every review's, oldest first.
contract ReviewState: {
    review?: Review
    comments: array(ReviewComment)
}

# `head` is the commit the person was looking at. A mismatch is a 409, so a comment never lands on a line
# the person did not see. `severity` left out means `blocker`.
contract CreateReviewCommentRequest: {
    head: string
    file: string
    side: enum(old, new)
    line: int
    severity?: enum(blocker, concern)
    text: string
}

# `head` is the commit the person was looking at, as in `CreateReviewCommentRequest`.
contract ReviewVerdictRequest: {
    head: string
}

operation /api/cards/{id}/review: {
    params: {
        id: string
    }
    get: {
        security: {
            policy: wilson.view
        }
        name: Read a review
        mcp: exclude # A review is a person's judgment of an agent's work
        service: ReviewService.state
        response: {
            200: {
                application/json: ReviewState
            }
            404:
        }
    }
    # Rejoins the review of the branch's current commit, or starts one, retiring any older open one.
    post: {
        name: Open a review
        mcp: exclude # A review is a person's judgment of an agent's work
        service: ReviewService.open
        response: {
            200: {
                application/json: ReviewState
            }
            400:
            404:
        }
    }
}

operation /api/cards/{id}/review/comments: {
    params: {
        id: string
    }
    post: {
        name: Add a review comment
        mcp: exclude # A review is a person's judgment of an agent's work
        service: ReviewService.addComment
        request: {
            application/json: CreateReviewCommentRequest
        }
        response: {
            200: {
                application/json: ReviewComment
            }
            400:
            404:
            409:
        }
    }
}

# A state the comment moves through rather than a delete. A comment already sent stays sent.
operation /api/cards/{id}/review/comments/{commentId}/resolve: {
    params: {
        id: string
        commentId: string
    }
    post: {
        name: Resolve a review comment
        mcp: exclude # A review is a person's judgment of an agent's work
        service: ReviewService.resolveComment
        response: {
            200: {
                application/json: ReviewComment
            }
            400:
            404:
        }
    }
}

# Sends every open comment to `ready`'s `onFail` stage as findings, and moves the card there. Comments are
# marked `sent`, so a later review re-locates them but does not send them again.
operation /api/cards/{id}/review/request-changes: {
    params: {
        id: string
    }
    post: {
        name: Request changes
        mcp: exclude # A review is a person's judgment of an agent's work
        service: ReviewService.requestChanges
        request: {
            application/json: ReviewVerdictRequest
        }
        response: {
            200: {
                application/json: ReviewState
            }
            400:
            404:
            409:
        }
    }
}
