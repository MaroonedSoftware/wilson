using System.Collections.ObjectModel;
using System.Text.Json;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Desktop.Core.Planning;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>One line of a conversation, as drawn.</summary>
public sealed record TranscriptLine(string Who, string Text);

/// <summary>A comment on the draft, as drawn.</summary>
public sealed record PlanCommentRow(string Id, string Quote, string Text, bool Resolved);

/// <summary>
/// Planning a card with its agent: the conversation, the draft it writes, and comments on that draft.
/// Only text that lands in the plan binds anything (PROJECT.md, decision 4).
/// </summary>
public sealed partial class PlanViewModel(ShellViewModel shell, string project, string id) : PageViewModel
{
    private readonly WilsonSdk _sdk = shell.Connection!.ForProject(project);
    private IReadOnlyList<PlanTurn> _turns = [];
    private string _savedDraft = string.Empty;

    public ObservableCollection<TranscriptLine> Lines { get; } = [];

    public ObservableCollection<PlanCommentRow> Comments { get; } = [];

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
    private string? _draft;

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

    [RelayCommand]
    public Task SendAsync() => TurnAsync(null);

    [RelayCommand]
    public Task AskForCutsAsync() => TurnAsync(PlanTurnRequestMode.Cuts);

    [RelayCommand]
    public Task AskForDraftAsync() => TurnAsync(PlanTurnRequestMode.Draft);

    [RelayCommand]
    public async Task SaveDraftAsync()
    {
        var body = Draft ?? string.Empty;
        try
        {
            await _sdk.Board.SaveAPlanDraftAsync(id, new SaveDraftRequest { Body = body });
            _savedDraft = body;
            Notice = "Saved as a new version of the plan.";
        }
        catch (HttpRequestException failure)
        {
            Notice = ApiError.Reason(failure);
        }
    }

    /// <summary>The server anchors a comment by its quote, so a quote that appears twice may be refused in its own words.</summary>
    [RelayCommand]
    public async Task AddCommentAsync()
    {
        if (string.IsNullOrWhiteSpace(Quote) || string.IsNullOrWhiteSpace(CommentText))
        {
            Notice = "Select some of the draft, then say what you think of it.";
            return;
        }

        try
        {
            var added = await _sdk.Board.AddAPlanCommentAsync(id, new CreatePlanCommentRequest { Quote = Quote, Prefix = string.Empty, Suffix = string.Empty, Text = CommentText.Trim() });
            Comments.Add(Row(added));
            Quote = null;
            CommentText = null;
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
            Comments[Comments.IndexOf(comment)] = Row(resolved);
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
                var draft = await _sdk.Board.GetAPlanDraftAsync(id, cancellationToken);
                Draft = _savedDraft = draft.Body;
                foreach (var comment in await _sdk.Board.ListPlanCommentsAsync(id, cancellationToken))
                {
                    Comments.Add(Row(comment));
                }

                Open = true;
            }
            catch (HttpRequestException failure)
            {
                Error = ApiError.Reason(failure);
                return;
            }
        }

        // A replay is everything after the last turn held, so coming back misses nothing.
        await shell.Connection!.FollowAsync(
            $"/api/cards/{Uri.EscapeDataString(id)}/plan/stream",
            project,
            signal => Dispatcher.UIThread.InvokeAsync(() => Follow(signal)).GetTask(),
            _turns.Count > 0 ? _turns[^1].Seq.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
            cancellationToken);
    }

    private static PlanCommentRow Row(PlanComment comment) => new(comment.Id, comment.Quote, comment.Text, comment.Resolved);

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

    /// <summary>The agent writes the draft, so a fresh one replaces the local copy unless it has unsaved edits.</summary>
    private async Task RefreshDraftAsync()
    {
        try
        {
            var body = (await _sdk.Board.GetAPlanDraftAsync(id)).Body;
            if (Draft == _savedDraft)
            {
                Draft = body;
            }

            _savedDraft = body;
        }
        catch (HttpRequestException)
        {
            // The reply is in. The draft shows on the next read.
        }
    }
}
