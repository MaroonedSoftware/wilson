namespace MaroonedSoftware.Wilson.Desktop.Core.Planning;

/// <summary>
/// The draft on screen against the one last accepted, by `DraftPane.tsx`. The agent writes the draft
/// while a person may be editing it, with no lock, and an edit in progress is never overwritten: a
/// different draft arriving under one is held as a collision, for the person to take or ignore.
/// </summary>
public sealed record DraftEdit(string Text, string? Baseline, string? Incoming)
{
    public static readonly DraftEdit Empty = new(string.Empty, null, null);

    public bool Loaded => Incoming is not null;

    public bool Dirty => Baseline is not null && Text != Baseline;

    public bool Collision => Dirty && Incoming is not null && Incoming != Baseline;

    /// <summary>A read from the server. Clean text follows it, and dirty text stays.</summary>
    public DraftEdit Receive(string body) => Dirty ? this with { Incoming = body } : new DraftEdit(body, body, body);

    public DraftEdit Typed(string? text) => this with { Text = text ?? string.Empty };

    public DraftEdit UseIncoming() => Incoming is { } body ? new DraftEdit(body, body, body) : this;

    /// <summary>What was just written is what the next read should find, so that read is no collision.</summary>
    public DraftEdit Saved() => this with { Baseline = Text, Incoming = Text };

    public bool CanApprove(string? cardBody) => Loaded && !string.IsNullOrWhiteSpace(Text) && Text != cardBody;
}
