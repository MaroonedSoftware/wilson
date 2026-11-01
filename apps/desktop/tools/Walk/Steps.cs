using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace Walk;

/// <summary>The flows, in the order a person would meet them.</summary>
internal static class Steps
{
    public static async Task RunAsync(Walker walk, string origin, string email, string password)
    {
        await walk.UntilAsync("the sign-in page", () => walk.Shell.Page is SignInViewModel);
        var signIn = walk.Page<SignInViewModel>();
        walk.Shot("01-sign-in");

        signIn.Address = "http:/nonsense";
        await signIn.SubmitAsync();
        await walk.UntilAsync("a bad address refused", () => signIn.Error is not null);

        signIn.Address = origin;
        signIn.Email = email;
        signIn.Password = "wrong";
        await signIn.SubmitAsync();
        await walk.UntilAsync("a wrong password refused", () => signIn.Error == "Wrong email or password.");
        walk.Shot("02-sign-in-refused");

        signIn.Password = password;
        await signIn.SubmitAsync();
        await walk.UntilAsync("the board", () => walk.Shell.Page is BoardViewModel);

        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("columns", () => board.Columns.Count > 0);
        await walk.UntilAsync("the feed live", () => board.Live);
        walk.Shot("03-board");

        await DiffAsync(walk, board);
        await CardsAsync(walk, board);
    }

    /// <summary>Only if the throwaway board has a card with a branch: a fresh one has none, and it takes a hand to give it one.</summary>
    private static async Task DiffAsync(Walker walk, BoardViewModel board)
    {
        if (board.Columns.SelectMany(column => column.Cards).FirstOrDefault(card => card.Branch is not null) is not { } branched)
        {
            Console.WriteLine("skip the diff: no card has a branch");
            return;
        }

        board.OpenCard(branched);
        var card = walk.Page<CardViewModel>();
        card.SelectedTab = 2;
        await walk.UntilAsync("the diff, or the refusal said", () => card.DiffNote is not null and not "Reading the diff.");
        Console.WriteLine($"     diff: {card.DiffNote} {card.DiffFiles.Count} files, {card.DiffRows.Count} rows");
        walk.Shot("03a-diff");
        card.SelectedFile = card.DiffFiles.FirstOrDefault(file => file.Path.EndsWith("BoardViewModel.cs", StringComparison.Ordinal)) ?? card.SelectedFile;
        walk.Shot("03b-diff-another-file");
        walk.Shell.Back();
        await walk.UntilAsync("back on the board", () => walk.Shell.Page == board);
    }

    private static async Task CardsAsync(Walker walk, BoardViewModel board)
    {
        var title = $"Walked {DateTime.UtcNow:HHmmss}";
        board.NewCard();
        var form = walk.Page<CardFormViewModel>();
        await form.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a card with no title refused", () => form.Error is not null);

        form.Title = title;
        form.Body = "## Plan\n\nMade by the desktop walk.\n\nA second paragraph, long enough to wrap and to show how a card's body reads at the width of a window rather than on a phone.";
        walk.Shot("04-new-card");
        await form.SaveCommand.ExecuteAsync(null);

        await walk.UntilAsync("back on the board", () => walk.Shell.Page == board);
        await walk.UntilAsync("the new card on the board", () => board.Columns.Any(column => column.Cards.Any(card => card.Title == title)));
        var made = board.Columns.SelectMany(column => column.Cards).First(card => card.Title == title);

        board.OpenCard(made);
        var card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the card", () => card.Card is not null);
        await walk.UntilAsync("the stages to move to", () => card.Stages.Count > 0);
        walk.Shot("05-card");

        card.MoveTo = card.Stages.First(stage => stage != card.Card!.Stage);
        var target = card.MoveTo;
        await card.MoveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the card moved, or the refusal said", () => card.Notice is not null);
        Console.WriteLine($"     moving to {target}: {card.Notice}");
        await walk.UntilAsync("the move in its activity", () => card.Events.Count > 0);
        walk.Shot("06-card-after-move");

        card.AskMerge();
        walk.Shot("07-card-confirm-merge");
        await card.ConfirmCommand.ExecuteAsync(null);
        await walk.UntilAsync("the merge's answer said", () => card.Acting is null && card.Notice is not null);
        Console.WriteLine($"     merge: {card.Notice}");
        walk.Shot("08-card-merge-refused");

        card.Edit();
        var edit = walk.Page<CardFormViewModel>();
        await walk.UntilAsync("the card in the form", () => edit.Title == title);
        edit.Title = $"{title} edited";
        await edit.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the edit on the card", () => walk.Shell.Page == card && card.Card?.Title.EndsWith("edited", StringComparison.Ordinal) == true);
        await PlanningAsync(walk, card);
        walk.Shell.Back();
        await ChatAsync(walk, board);
    }

    private static async Task PlanningAsync(Walker walk, CardViewModel card)
    {
        await walk.UntilAsync("the card can be planned", () => card.CanPlan);
        card.OpenPlan();
        var plan = walk.Page<PlanViewModel>();
        await walk.UntilAsync("the session open, or the refusal said", () => plan.Open || plan.Error is not null);
        Console.WriteLine($"     open: {plan.Open}, error: {plan.Error}");
        walk.Shot("09-plan");
        if (!plan.Open)
        {
            walk.Shell.Back();
            return;
        }

        await walk.UntilAsync("the plan stream live", () => plan.Live);

        plan.Draft = "# Plan\n\nDo the first thing.\n\nThen the second thing.";
        await plan.SaveDraftCommand.ExecuteAsync(null);
        await walk.UntilAsync("the draft saved", () => plan.Notice is not null);
        Console.WriteLine($"     save: {plan.Notice}");

        plan.Quote = "the first thing";
        plan.CommentText = "Which first thing?";
        await plan.AddCommentCommand.ExecuteAsync(null);
        await walk.UntilAsync("the comment added", () => plan.Comments.Count > 0);
        walk.Shot("10-plan-commented");
        await plan.ResolveCommentCommand.ExecuteAsync(plan.Comments[0]);
        await walk.UntilAsync("the comment resolved", () => plan.Comments[0].Resolved);

        plan.Composer = "Reply with the single word: ok";
        await plan.SendCommand.ExecuteAsync(null);
        await walk.UntilAsync("the turn answered, or the refusal said", () => plan.Idle, 120);
        Console.WriteLine($"     turn: lines {plan.Lines.Count}, error: {plan.Error}");
        walk.Shot("11-plan-turn");

        await plan.CloseSessionCommand.ExecuteAsync(null);
        await walk.UntilAsync("back on the card", () => walk.Shell.Page == card);
    }

    private static async Task ChatAsync(Walker walk, BoardViewModel board)
    {
        board.OpenChat();
        var threads = walk.Page<ThreadsViewModel>();
        await threads.StartThreadCommand.ExecuteAsync(null);
        var chat = walk.Page<ChatViewModel>();
        chat.Composer = "Reply with the single word: ok";
        await chat.SendCommand.ExecuteAsync(null);
        await walk.UntilAsync("the chat answered, or the refusal said", () => chat.Idle, 120);
        Console.WriteLine($"     chat: lines {chat.Lines.Count}, error: {chat.Error}");
        walk.Shot("12-chat");
        walk.Shell.Back();
        await walk.UntilAsync("the thread listed", () => threads.Threads.Count > 0);
        walk.Shot("13-threads");
        walk.Shell.Back();
    }
}
