using CommunityToolkit.Mvvm.ComponentModel;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>
/// A question the chat asked, answered here with a click: its 1-4 prompts as radio buttons or checkboxes plus an
/// "Other" box, one Submit for all of it. Past its expiry, or once dismissed by an ordinary message, it says so
/// rather than offering a button the server would refuse. Once answered it keeps what was chosen, with no controls.
/// As the web app's `ChatQuestionCard`. Kept across redraws by id, so a half-filled card survives the thread being read again.
/// </summary>
public sealed partial class QuestionCard : ObservableObject
{
    private QuestionDraft _draft;
    private bool _syncing;

    public QuestionCard(ChatPendingQuestion question)
    {
        ArgumentNullException.ThrowIfNull(question);

        Id = question.Id;
        Questions = question.Questions;
        _draft = QuestionDraft.Empty(Questions);
        Prompts = [.. Questions.Select((prompt, i) => new QuestionPrompt(this, i, prompt))];
    }

    public string Id { get; }

    public IReadOnlyList<ChatQuestion> Questions { get; }

    public IReadOnlyList<QuestionPrompt> Prompts { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit))]
    private bool _awaiting;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit))]
    [NotifyPropertyChangedFor(nameof(Editable))]
    private bool _submitting;

    /// <summary>"answered", "dismissed" or "expired" once it no longer waits.</summary>
    [ObservableProperty]
    private string? _outcome;

    [ObservableProperty]
    private string? _expires;

    [ObservableProperty]
    private string? _error;

    public bool Editable => !Submitting;

    public bool CanSubmit => Awaiting && !Submitting && _draft.Complete;

    /// <summary>The request body for what is picked now.</summary>
    public List<ChatQuestionAnswer> Answers() => _draft.Answers();

    /// <summary>Takes the stored question's state, keeping whatever has been picked so far.</summary>
    public void Update(ChatPendingQuestion question, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(question);

        Outcome = ChatRules.QuestionOutcome(question, now);
        Awaiting = Outcome is null;
        Expires = Awaiting ? $"Expires {ChatRules.Relative(question.ExpiresAt, now)}." : null;
        for (var i = 0; i < Prompts.Count; i++)
        {
            Prompts[i].Answered = Awaiting ? null : ChatRules.AnswerText(Questions[i], question.Answers?.ElementAtOrDefault(i));
        }
    }

    internal void Choose(int index, int option)
    {
        if (!_syncing)
        {
            Apply(_draft.Choose(Questions, index, option));
        }
    }

    internal void Type(int index, string text)
    {
        if (!_syncing)
        {
            Apply(_draft.Type(Questions, index, text));
        }
    }

    /// <summary>Takes a new draft and redraws every control from it, so a control never disagrees with what will be sent.</summary>
    private void Apply(QuestionDraft draft)
    {
        _draft = draft;
        _syncing = true;
        try
        {
            for (var i = 0; i < Prompts.Count; i++)
            {
                Prompts[i].Sync(draft.Chosen[i], draft.Other[i]);
            }
        }
        finally
        {
            _syncing = false;
        }

        OnPropertyChanged(nameof(CanSubmit));
    }
}

/// <summary>One of a question card's prompts: its header, the question, its options and its "Other" box.</summary>
public sealed partial class QuestionPrompt : ObservableObject
{
    private readonly QuestionCard _card;
    private readonly int _index;

    internal QuestionPrompt(QuestionCard card, int index, ChatQuestion prompt)
    {
        _card = card;
        _index = index;
        Header = prompt.Header;
        Text = prompt.Text;
        MultiSelect = prompt.MultiSelect;
        Options = [.. prompt.Options.Select((option, i) => new QuestionOption(this, i, option.Label, option.Description))];
    }

    public string Header { get; }

    public string Text { get; }

    public bool MultiSelect { get; }

    public bool SingleSelect => !MultiSelect;

    /// <summary>A name for the radio group, so each prompt's single choice is its own.</summary>
    public string Group => $"question-{_card.Id}-{_index}";

    public IReadOnlyList<QuestionOption> Options { get; }

    /// <summary>What was chosen, once the question no longer waits; null while it does or when nothing was given.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasAnswer))]
    private string? _answered;

    public bool HasAnswer => Answered is not null;

    [ObservableProperty]
    private string _other = string.Empty;

    partial void OnOtherChanged(string value) => _card.Type(_index, value ?? string.Empty);

    internal void Choose(int option) => _card.Choose(_index, option);

    internal void Sync(IReadOnlySet<int> chosen, string other)
    {
        foreach (var option in Options)
        {
            option.IsChosen = chosen.Contains(option.Index);
        }

        Other = other;
    }
}

/// <summary>One suggested answer, ticked or not.</summary>
public sealed partial class QuestionOption(QuestionPrompt prompt, int index, string label, string description) : ObservableObject
{
    public int Index { get; } = index;

    public string Label { get; } = label;

    public string Description { get; } = description;

    public bool HasDescription => Description.Length > 0;

    /// <summary>
    /// The radio group this option's button is in: the prompt's, or one of its own on a multiple choice, where the
    /// radio button is hidden and must not untick the others' through their shared binding.
    /// </summary>
    public string Group => prompt.MultiSelect ? $"{prompt.Group}-{Index}" : prompt.Group;

    [ObservableProperty]
    private bool _isChosen;

    // A radio button unticked by its group is not a choice; the draft unticks it itself.
    partial void OnIsChosenChanged(bool value)
    {
        if (value || prompt.MultiSelect)
        {
            prompt.Choose(Index);
        }
    }
}
