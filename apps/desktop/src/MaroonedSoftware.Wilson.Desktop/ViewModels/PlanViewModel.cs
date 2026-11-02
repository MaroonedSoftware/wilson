using System.Collections.ObjectModel;
using System.Text.Json;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Planning;
using MaroonedSoftware.Wilson.Desktop.Views;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One line of a conversation, as drawn.</summary>
public sealed record TranscriptLine(string Who, string Text);

/// <summary>A comment on the draft, as drawn.</summary>
public sealed record PlanCommentRow(string Id, string Quote, string Text, bool Resolved, PlanAnchor Anchor);

/// <summary>
/// Planning a card with its agent: the conversation, the draft it writes, and comments on that draft.
/// Only text that lands in the plan binds anything (PROJECT.md, decision 4).
/// </summary>
public sealed partial class PlanViewModel(ShellViewModel shell, string project, string id) : PageViewModel
{
    private static readonly TimeSpan DraftPoll = TimeSpan.FromSeconds(4);

    private readonly WilsonSdk _sdk = shell.Connection!.ForProject(project);
    private IReadOnlyList<PlanTurn> _turns = [];
    private DraftEdit _edit = DraftEdit.Empty;
    private PlanAnchor? _selected;
    private string? _cardBody;
    private bool _applying;
    private List<PlanCommentRow> _comments = [];

    public ObservableCollection<TranscriptLine> Lines { get; } = [];

    /// <summary>Those the draft still holds.</summary>
    public ObservableCollection<PlanCommentRow> Comments { get; } = [];

    /// <summary>Those whose passage is gone. They stay listed, as moving one would be a guess.</summary>
    public ObservableCollection<PlanCommentRow> Outdated { get; } = [];

    public ObservableCollection<DraftDiffLine> ApproveLines { get; } = [];

    public ShellViewModel Shell => shell;

    public string Heading => $"Planning {id}";

    [ObservableProperty]
    private bool _open;

    [ObservableProperty]
    private string _pending = string.Empty;

    [ObservableProperty]
    private string? _sent;

    [ObservableProperty]
    private string? _composer;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Unsaved))]
    [NotifyPropertyChangedFor(nameof(Collision))]
    [NotifyPropertyChangedFor(nameof(CanApprove))]
    private string? _draft;

    [ObservableProperty]
    private bool _preview;

    [ObservableProperty]
    private IReadOnlyList<MarkdownMark>? _marks;

    [ObservableProperty]
    private bool _approving;

    [ObservableProperty]
    private string? _approveError;

    [ObservableProperty]
    private string? _quote;

    [ObservableProperty]
    private string? _commentText;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private bool _sending;

    [ObservableProperty]
    private bool _live;

    [ObservableProperty]
    private string? _notice;

    [ObservableProperty]
    private string? _error;

    public bool Idle => !Sending;

    public bool Unsaved => _edit.Dirty && !_edit.Collision;

    public bool Collision => _edit.Collision;

    public bool CanApprove => _edit.CanApprove(_cardBody);

    public string ApproveTitle => $"Write this as a new version of {id}?";

    [RelayCommand]
    public Task SendAsync() => TurnAsync(null);

    [RelayCommand]
    public Task AskForCutsAsync() => TurnAsync(PlanTurnRequestMode.Cuts);

    [RelayCommand]
    public Task AskForDraftAsync() => TurnAsync(PlanTurnRequestMode.Draft);

    /// <summary>Takes the agent's draft over an edit, once the person has chosen to.</summary>
    [RelayCommand]
    public void UseIncoming() => Apply(_edit.UseIncoming());

    /// <summary>Nothing is written until the changes have been seen.</summary>
    [RelayCommand]
    public void AskApprove()
    {
        ApproveLines.Clear();
        foreach (var line in DraftDiff.Lines(_cardBody ?? string.Empty, Draft ?? string.Empty))
        {
            ApproveLines.Add(line);
        }

        ApproveError = null;
        Approving = true;
    }

    [RelayCommand]
    public void CancelApprove() => Approving = false;

    /// <summary>The server is the only judge of a draft. A refusal stays on the dialog, and the draft stays as it is.</summary>
    [RelayCommand]
    public async Task SaveDraftAsync()
    {
        var body = Draft ?? string.Empty;
        try
        {
            await _sdk.Board.SaveAPlanDraftAsync(id, new SaveDraftRequest { Body = body });
            _cardBody = body;
            Apply(_edit.Saved());
            Approving = false;
            Notice = "Saved as a new version of the plan.";
        }
        catch (HttpRequestException failure)
        {
            ApproveError = ApiError.Reason(failure);
        }
    }

    /// <summary>A passage chosen in the preview. Offsets go no further than this: the anchor is the quote and what surrounds it.</summary>
    public void SelectPassage(int start, int end, string selected)
    {
        ArgumentNullException.ThrowIfNull(selected);

        var text = ChatMarkdown.RenderedText(Draft ?? string.Empty);
        if (end > text.Length || text[start..end] != selected)
        {
            // A line break in the selection can throw the count off. The words themselves are still the words.
            start = text.IndexOf(selected, StringComparison.Ordinal);
            end = start + selected.Length;
        }

        if (start >= 0)
        {
            _selected = PlanAnchors.Capture(text, start, end);
            Quote = _selected.Quote;
        }
    }

    [RelayCommand]
    public void CancelComment()
    {
        _selected = null;
        Quote = null;
        CommentText = null;
    }

    [RelayCommand]
    public async Task AddCommentAsync()
    {
        if (_selected is not { } anchor || string.IsNullOrWhiteSpace(CommentText))
        {
            return;
        }

        try
        {
            var added = await _sdk.Board.AddAPlanCommentAsync(id, new CreatePlanCommentRequest { Quote = anchor.Quote, Prefix = anchor.Prefix, Suffix = anchor.Suffix, Text = CommentText.Trim() });
            _comments.Add(Row(added));
            CancelComment();
            Sort();
        }
        catch (HttpRequestException failure)
        {
            Notice = ApiError.Reason(failure);
        }
    }

    [RelayCommand]
    public async Task ResolveCommentAsync(PlanCommentRow comment)
    {
        ArgumentNullException.ThrowIfNull(comment);

        try
        {
            var resolved = await _sdk.Board.ResolveAPlanCommentAsync(id, comment.Id);
            _comments[_comments.IndexOf(comment)] = Row(resolved);
            Sort();
        }
        catch (HttpRequestException failure)
        {
            Notice = ApiError.Reason(failure);
        }
    }

    [RelayCommand]
    public async Task CloseSessionAsync()
    {
        try
        {
            await _sdk.Board.CloseAPlanningSessionAsync(id);
            shell.Back();
        }
        catch (HttpRequestException failure)
        {
            Notice = ApiError.Reason(failure);
        }
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        if (!Open)
        {
            try
            {
                await _sdk.Board.OpenAPlanningSessionAsync(id, cancellationToken);
                _cardBody = (await _sdk.Board.GetCardAsync(id, cancellationToken)).Body;
                var draft = await _sdk.Board.GetAPlanDraftAsync(id, cancellationToken);
                _comments = [.. (await _sdk.Board.ListPlanCommentsAsync(id, cancellationToken)).Select(Row)];
                Apply(_edit.Receive(draft.Body));
                Open = true;
            }
            catch (HttpRequestException failure)
            {
                Error = ApiError.Reason(failure);
                return;
            }
        }

        _ = EveryAsync(DraftPoll, () => _ = RefreshDraftAsync(), cancellationToken);

        // A replay is everything after the last turn held, so coming back misses nothing.
        await shell.Connection!.FollowAsync(
            $"/api/cards/{Uri.EscapeDataString(id)}/plan/stream",
            project,
            signal => Dispatcher.UIThread.InvokeAsync(() => Follow(signal)).GetTask(),
            _turns.Count > 0 ? _turns[^1].Seq.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
            cancellationToken);
    }

    private static PlanCommentRow Row(PlanComment comment) =>
        new(comment.Id, comment.Quote, comment.Text, comment.Resolved, new PlanAnchor(comment.Quote, comment.Prefix, comment.Suffix));

    partial void OnDraftChanged(string? value)
    {
        if (!_applying)
        {
            _edit = _edit.Typed(value);
            OnPropertyChanged(nameof(Unsaved));
            OnPropertyChanged(nameof(CanApprove));
        }
    }

    partial void OnPreviewChanged(bool value) => Sort();

    /// <summary>Text from anywhere but the keyboard, which leaves the edit's state alone.</summary>
    private void Apply(DraftEdit edit)
    {
        var changed = edit.Text != Draft;
        _edit = edit;
        _applying = true;
        Draft = edit.Text;
        _applying = false;
        OnPropertyChanged(nameof(Unsaved));
        OnPropertyChanged(nameof(Collision));
        OnPropertyChanged(nameof(CanApprove));
        // Not on every poll: redrawing the preview would lose a selection being made.
        if (changed)
        {
            Sort();
        }
    }

    /// <summary>Every comment against the draft as it now reads: marked where it is found, and listed as outdated where it is not.</summary>
    private void Sort()
    {
        var text = ChatMarkdown.RenderedText(Draft ?? string.Empty);
        var found = _comments.Select(comment => (Comment: comment, Range: PlanAnchors.Locate(text, comment.Anchor))).ToList();
        Comments.Clear();
        Outdated.Clear();
        foreach (var (comment, range) in found)
        {
            (range is null ? Outdated : Comments).Add(comment);
        }

        Marks = [.. found.Where(item => item.Range is not null).Select(item => new MarkdownMark(item.Range!.Value.Start, item.Range.Value.End, item.Comment.Resolved))];
    }

    private void Follow(StreamSignal signal)
    {
        switch (signal)
        {
            case StreamSignal.Live:
                Live = true;
                break;
            case StreamSignal.Down:
                // A delta has no id, so a drop mid-reply clears the partial text and the finished turn replaces it.
                Live = false;
                Pending = string.Empty;
                break;
            case StreamSignal.Received { Event.Event: "delta" } delta:
                Pending += delta.Event.Data;
                break;
            case StreamSignal.Received { Event.Event: "turn" } turn:
                Show(PlanTranscript.Insert(_turns, JsonSerializer.Deserialize<PlanTurn>(turn.Event.Data, SdkJson.Options)!));
                Pending = string.Empty;
                break;
            default:
                break;
        }
    }

    private void Show(IReadOnlyList<PlanTurn> turns)
    {
        _turns = turns;
        Lines.Clear();
        foreach (var turn in turns)
        {
            Lines.Add(new TranscriptLine(turn.Role == PlanTurnRole.User ? "You" : "Wilson", turn.Content));
        }
    }

    private async Task TurnAsync(PlanTurnRequestMode? mode)
    {
        var text = Composer?.Trim() ?? string.Empty;
        if (text.Length == 0 && mode is null)
        {
            return;
        }

        Sending = true;
        Error = null;
        Composer = null;
        Sent = text;
        try
        {
            var reply = await _sdk.Board.SendAPlanTurnAsync(id, new PlanTurnRequest { Text = text, Mode = mode });
            Show(PlanTranscript.WithReply(_turns, reply, text));
            await RefreshDraftAsync();
        }
        catch (HttpRequestException failure)
        {
            Composer = text;
            Error = ApiError.Reason(failure);
        }
        finally
        {
            Pending = string.Empty;
            Sent = null;
            Sending = false;
        }
    }

    /// <summary>The agent writes the draft whenever it likes, so this reads it again on a clock as well as after a turn.</summary>
    private async Task RefreshDraftAsync()
    {
        try
        {
            Apply(_edit.Receive((await _sdk.Board.GetAPlanDraftAsync(id)).Body));
        }
        catch (HttpRequestException)
        {
            // The reply is in. The draft shows on the next read.
        }
    }
}
