using Avalonia;
using Avalonia.Input;
using Avalonia.Styling;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;
using MaroonedSoftware.Wilson.Desktop.ViewModels;

namespace Walk;

/// <summary>The flows, in the order a person would meet them.</summary>
internal static class Steps
{
    public static async Task RunAsync(Walker walk, string origin, string email, string password)
    {
        await walk.UntilAsync("the sign-in page, under no header", () => walk.Shell.Page is SignInViewModel && !walk.Shell.SignedIn);
        var signIn = walk.Page<SignInViewModel>();
        walk.Shot("01-sign-in");

        signIn.Start();
        await walk.UntilAsync("the address step", () => signIn.Finding);
        walk.Shot("01-sign-in-server");

        signIn.Address = "http:/nonsense";
        await signIn.CheckAsync();
        await walk.UntilAsync("a bad address refused", () => signIn.Error is not null);

        signIn.Address = "http://localhost:9";
        await signIn.CheckAsync();
        await walk.UntilAsync("no answer said", () => signIn.Error?.StartsWith("Nothing answered", StringComparison.Ordinal) is true);
        walk.Shot("01-sign-in-no-answer");

        signIn.Address = origin;
        await signIn.CheckAsync();
        await walk.UntilAsync("the password step", () => signIn.ShowsPasswordStep);
        walk.Shot("02-sign-in-password");

        signIn.Back();
        await walk.UntilAsync("back at the address", () => signIn.Finding);
        signIn.Back();
        await walk.UntilAsync("back at the password, a server being kept", () => signIn.ShowsPasswordStep);

        signIn.Email = email;
        signIn.Password = "wrong";
        await signIn.SubmitAsync();
        await walk.UntilAsync("a wrong password refused", () => signIn.Error == "Wrong email or password.");
        walk.Shot("02-sign-in-refused");

        // Posed: the seeded operator has no authenticator, so signing in never reaches it.
        signIn.Step = SignInStep.Code;
        walk.Shot("02-sign-in-code");
        signIn.Back();

        signIn.Password = password;
        await signIn.SubmitAsync();
        await walk.UntilAsync("chat", () => walk.Shell.Page is ThreadsViewModel);

        var home = walk.Page<ThreadsViewModel>();
        await walk.UntilAsync("a chat open", () => home.Chat is not null);
        await walk.UntilAsync("the chats listed", () => home.Threads.Count > 0 || home.NoChats);
        Console.WriteLine($"     home: {home.Threads.Count} chats");
        await walk.UntilAsync("the header on Chat, with no feed to report", () => walk.Shell.OnChat && walk.Shell.Feed is null);
        walk.Shot("03-chat-home");
        await AppearanceAsync(walk);
        walk.Shell.ShowBoardCommand.Execute(null);

        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("columns", () => board.Columns.Count > 0);
        await walk.UntilAsync("the feed live in the header", () => walk.Shell.OnBoard && walk.Shell.Feed is { Live: true });
        walk.Shot("03-board");
        await FilterAsync(walk, board);
        await ToolActivityAsync(walk, board);

        await DiffAsync(walk, board);
        await CardsAsync(walk, board);
        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("back on chat", () => walk.Shell.Page == home);
        await ChatAsync(walk, home);

        await walk.Shell.SignOutCommand.ExecuteAsync(null);
        await walk.UntilAsync("signing out from the header", () => walk.Shell.Page is SignInViewModel && !walk.Shell.SignedIn);
    }

    /// <summary>Round all three, ending where it began, as the file records each.</summary>
    private static async Task AppearanceAsync(Walker walk)
    {
        for (var press = 0; press < 3; press++)
        {
            walk.Shell.NextAppearanceCommand.Execute(null);
            var appearance = walk.Shell.Appearance;
            var variant = appearance switch
            {
                Appearance.Light => ThemeVariant.Light,
                Appearance.Dark => ThemeVariant.Dark,
                _ => ThemeVariant.Default,
            };
            await walk.UntilAsync($"the app drawn {appearance}, and remembered", () => Application.Current!.RequestedThemeVariant == variant && walk.Settings().Appearance == appearance);
            walk.Shot($"03-appearance-{appearance.ToString().ToLowerInvariant()}");
        }
    }

    /// <summary>A tool call written to the throwaway database, which reaches the tile through the real feed.</summary>
    private static async Task ToolActivityAsync(Walker walk, BoardViewModel board)
    {
        var tile = board.Columns.SelectMany(column => column.Cards).First(tile => tile.Card.Stage == "implementing");
        Walker.Emit(tile.Card.Id, tile.Card.Stage, "tool.executed", """{"tool":"bash","command":"pnpm test"}""");
        await walk.UntilAsync("the tool call on its tile", () => board.Columns.SelectMany(column => column.Cards).Any(other => other.Card.Id == tile.Card.Id && other.LastEvent is not null));
        walk.Shot("03-board-tool-activity");
    }

    /// <summary>The first card by its id, then a filter nothing matches, then none.</summary>
    private static async Task FilterAsync(Walker walk, BoardViewModel board)
    {
        var first = board.Columns.SelectMany(column => column.Cards).First().Card;
        board.Filter = first.Id;
        await walk.UntilAsync("the filter leaving one card", () => board.Count?.StartsWith("1 of ", StringComparison.Ordinal) == true);
        walk.Shot("03-board-filtered");
        board.Filter = "nothing has this title";
        await walk.UntilAsync("the filter leaving none", () => board.Columns.All(column => column.Cards.Count == 0));
        board.Filter = null;
        await walk.UntilAsync("the whole board back", () => board.Count?.Contains(" of ", StringComparison.Ordinal) == false);
    }

    /// <summary>Only if the throwaway board has a card with a branch: a fresh one has none, and it takes a hand to give it one.</summary>
    private static async Task DiffAsync(Walker walk, BoardViewModel board)
    {
        if (board.Columns.SelectMany(column => column.Cards).Select(tile => tile.Card).FirstOrDefault(card => card.Branch is not null) is not { } branched)
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
        form.Body = "## Plan\n\nMade by the desktop walk, after [[0001]].\n\n- One **bold** item\n- Another with `code`\n\nA second paragraph, long enough to wrap and to show how a card's body reads at the width of a window rather than on a phone.";
        walk.Shot("04-new-card");
        await form.SaveCommand.ExecuteAsync(null);

        await walk.UntilAsync("back on the board", () => walk.Shell.Page == board);
        await walk.UntilAsync("the new card on the board", () => board.Columns.Any(column => column.Cards.Any(tile => tile.Card.Title == title)));
        await DragAsync(walk, board, title);
        var made = board.Columns.SelectMany(column => column.Cards).Select(tile => tile.Card).First(card => card.Title == title);

        board.OpenCard(made);
        var card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the card", () => card.Card is not null);
        await walk.UntilAsync("the stages to move to", () => card.Stages.Count > 0);
        await walk.UntilAsync("the card live, still under Board", () => walk.Shell.OnBoard && walk.Shell.Feed is CardViewModel { Live: true });
        await walk.Shell.Feed!.RefreshCommand.ExecuteAsync(null);
        walk.Shot("05-card");

        walk.ClickText("0001");
        await walk.UntilAsync("a reference opening its card", () => walk.Shell.Page is CardViewModel { Id: "0001" });
        walk.Shell.Back();
        await walk.UntilAsync("back from the reference", () => walk.Shell.Page == card);

        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("chat from a card", () => walk.Shell.OnChat);
        walk.Shell.Push(card);
        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("the same board back", () => walk.Shell.Page == board && !walk.Shell.CanGoBack);
        board.OpenCard(made);
        card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the stages to move to again", () => card.Stages.Count > 0);
        await ToolCallsAsync(walk, card);

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
        await walk.UntilAsync("back on the board", () => walk.Shell.Page == board);
    }

    /// <summary>By pointer through Avalonia's own input: a press that opens, one that barely moves, a refused drop and a real one.</summary>
    private static async Task DragAsync(Walker walk, BoardViewModel board, string title)
    {
        BoardTile Tile() => board.Columns.SelectMany(column => column.Cards).First(tile => tile.Card.Title == title);
        BoardColumn Column(string name) => board.Columns.First(column => column.Name == name);

        async Task BackToBoardAsync()
        {
            walk.Shell.Back();
            await walk.UntilAsync("back on the board, live", () => walk.Shell.Page == board && board.Live);
        }

        walk.Click(walk.Center(Tile()));
        await walk.UntilAsync("a click opening the card", () => walk.Shell.Page is CardViewModel);
        await BackToBoardAsync();

        var start = walk.Center(Tile());
        walk.Drag(start, start + new Point(3, 2));
        await walk.UntilAsync("a small slip still opening the card", () => walk.Shell.Page is CardViewModel);
        await BackToBoardAsync();

        // A re-read landing during a press is what the feed does at any moment.
        var pressed = walk.Center(Tile());
        walk.Down(pressed);
        await board.RefreshCommand.ExecuteAsync(null);
        walk.Up(pressed);
        await walk.UntilAsync("a click surviving a re-read during its press", () => walk.Shell.Page is CardViewModel);
        await BackToBoardAsync();

        var stage = Tile().Card.Stage;
        var picked = walk.Center(Tile());
        var over = walk.Center(Column("merged"));
        walk.Down(picked);
        walk.MoveTo(picked + new Point(20, 0));
        walk.MoveTo(over);
        await walk.UntilAsync("a card held over a column", () => Tile().Dragged && Column("merged").Target);
        walk.Press(Key.Escape, PhysicalKey.Escape);
        await walk.UntilAsync("Escape putting it back", () => !Tile().Dragged && !Column("merged").Target);
        walk.Up(over);
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the cancelled drag asking for nothing", () => Tile().Card.Stage == stage && walk.Shell.Page == board);

        // The server allows nearly any move, so a refusal needs a card gone from under its tile: a row of the walk's own.
        Walker.Sql("insert into wilson.cards (project, id, title, stage, body) select project, '9998', 'Walked away', 'parking-lot', '' from wilson.cards limit 1");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the walk's own card", () => board.Columns.Any(column => column.Cards.Any(tile => tile.Card.Id == "9998")));
        Walker.Sql("delete from wilson.cards where id = '9998'");
        var gone = board.Columns.SelectMany(column => column.Cards).First(tile => tile.Card.Id == "9998");
        walk.Drag(walk.Center(gone), walk.Center(Column("planning")));
        await walk.UntilAsync("a drop refused in the server's words", () => board.Error is not null);
        Console.WriteLine($"     onto planning: {board.Error}");
        await walk.UntilAsync("the card gone after the re-read", () => board.Columns.All(column => column.Cards.All(tile => tile.Card.Id != "9998")));
        walk.Shot("04b-board-drop-refused");

        Walker.Sql("insert into wilson.cards (project, id, title, stage, body) select project, '9999', 'Walked across', 'parking-lot', '' from wilson.cards limit 1");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("another of the walk's own", () => board.Columns.Any(column => column.Cards.Any(tile => tile.Card.Id == "9999")));
        var across = board.Columns.SelectMany(column => column.Cards).First(tile => tile.Card.Id == "9999");
        board.ToggleCollapsedCommand.Execute(Column("implementing"));
        board.ToggleCollapsedCommand.Execute(Column("merged"));
        await walk.UntilAsync("columns folded and remembered", () => walk.Settings().Collapsed[board.Project!].Contains("merged"));
        walk.Shot("04b-board-collapsed");
        walk.Drag(walk.Center(across), walk.Center(Column("implementing")), "04c-board-dragging");
        await walk.UntilAsync("the drop moving the card", () => board.Columns.First(column => column.Name == "implementing").Cards.Any(tile => tile.Card.Id == "9999"));
        walk.Shot("04d-board-dropped");
        await walk.UntilAsync("a redraw keeping them folded", () => Column("merged").Collapsed);
        board.ToggleCollapsedCommand.Execute(Column("implementing"));
        board.ToggleCollapsedCommand.Execute(Column("merged"));
        await walk.UntilAsync("the columns open again", () => walk.Settings().Collapsed[board.Project!].Count == 0);
        Walker.Sql("delete from wilson.card_versions where card_id = '9999'; delete from wilson.cards where id = '9999'");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the walk's own card gone", () => board.Columns.All(column => column.Cards.All(tile => tile.Card.Id != "9999")));
        await Task.Delay(TimeSpan.FromSeconds(1));
        await ReorderAsync(walk, board);
    }

    /// <summary>The second parked card over the first and back, each read back from the server, and one refused.</summary>
    private static async Task ReorderAsync(Walker walk, BoardViewModel board)
    {
        IReadOnlyList<BoardTile> Lot() => board.Columns.First(column => column.Name == BoardRules.ParkingLot).Cards;
        var (first, second) = (Lot()[0].Card.Id, Lot()[1].Card.Id);

        walk.Drag(walk.Center(Lot()[1]), walk.Center(Lot()[0]), "04e-board-reordering");
        await walk.UntilAsync("the new order at once", () => Lot()[0].Card.Id == second);
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the server agreeing", () => Lot()[0].Card.Id == second && Lot()[1].Card.Id == first);
        walk.Shot("04f-board-reordered");
        await Task.Delay(TimeSpan.FromSeconds(1));

        walk.Drag(walk.Center(Lot()[1]), walk.Center(Lot()[0]));
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the order back", () => Lot()[0].Card.Id == first && Lot()[1].Card.Id == second);

        Walker.Sql("insert into wilson.cards (project, id, title, stage, body) select project, '9997', 'Walked away', 'parking-lot', '' from wilson.cards limit 1");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the walk's own card parked", () => Lot().Any(tile => tile.Card.Id == "9997"));
        Walker.Sql("delete from wilson.cards where id = '9997'");
        walk.Drag(walk.Center(Lot().First(tile => tile.Card.Id == "9997")), walk.Center(Lot()[0]));
        await walk.UntilAsync("a reorder refused, and put back", () => board.Error?.StartsWith("Could not reorder", StringComparison.Ordinal) == true && Lot()[0].Card.Id == first);
        Console.WriteLine($"     reorder: {board.Error}");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("that card gone", () => Lot().All(tile => tile.Card.Id != "9997"));
        await Task.Delay(TimeSpan.FromSeconds(1));
    }

    private static async Task ToolCallsAsync(Walker walk, CardViewModel card)
    {
        await walk.UntilAsync("no tool calls said", () => card.ToolsNote is not null && card.Tools.Count == 0);
        card.SelectedTab = 1;
        walk.Shot("05-card-no-tools");
        await walk.UntilAsync("the card live", () => card.Live);
        Walker.Emit(card.Id, card.Card!.Stage, "tool.executed", """{"tool":"bash","command":"pnpm test --filter @wilson/api"}""");
        Walker.Emit(card.Id, card.Card.Stage, "tool.denied", """{"tool":"write","reason":"outside the files in scope","path":"secrets.env"}""");
        Walker.Emit(card.Id, card.Card.Stage, "tool.executed", """{"tool":"Edit","path":"apps/desktop/CLAUDE.md"}""");
        await walk.UntilAsync("the tool calls arriving", () => card.Tools.Count == 3);
        walk.Shot("05-card-tools");
        card.SelectedTab = 0;
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

    private static async Task ChatAsync(Walker walk, ThreadsViewModel home)
    {
        home.NewChat();
        var chat = home.Chat!;
        await walk.UntilAsync("the greeting", () => chat.Empty);
        walk.Shot("12-new-chat");

        walk.Press(Key.Tab, PhysicalKey.Tab);
        await walk.UntilAsync("Tab taking the suggestion", () => chat.Composer == chat.Starters[0]);
        chat.Composer = null;

        walk.Type("Reply with the single word: ok");
        await walk.UntilAsync("typing in the box", () => chat.CanSend);
        walk.Press(Key.Enter, PhysicalKey.Enter);
        await walk.UntilAsync("Enter sending it", () => chat.Sending);
        walk.Shot("13a-chat-working");
        await walk.UntilAsync("the chat answered, or the refusal said", () => chat.Idle, 120);
        Console.WriteLine($"     chat: entries {chat.Entries.Count}, error: {chat.Error}");
        await walk.UntilAsync("the chat named in the rail", () => home.Threads.Any(thread => thread.Current && thread.Title != "New chat"));
        walk.Shot("13-chat");

        walk.Type("Reply with a level two heading, a sentence with bold, italic and inline code, a link to https://example.com, a two item list, a short code block and a blockquote. Mention no tools.");
        walk.Press(Key.Enter, PhysicalKey.Enter);
        await walk.UntilAsync("that sending", () => chat.Sending);
        await walk.UntilAsync("the answer arriving, or the turn over", () => chat.Draft.Length > 0 || chat.Idle, 120);
        Console.WriteLine($"     streamed before the turn ended: {chat.Sending}, {chat.Draft.Length} characters");
        walk.Shot("14a-chat-streaming");
        await walk.UntilAsync("that answered, or the refusal said", () => chat.Idle, 120);
        Console.WriteLine($"     chat: entries {chat.Entries.Count}, error: {chat.Error}");
        walk.Shot("14-chat-markdown");

        // Posed: nothing in a walk can make the agent propose a change on cue.
        chat.Entries.Add(new AnswerEntry("Moving it now needs your say-so.", [new ChatActivity("get card in wilson", false, "{}"), new ChatActivity("list stages", true, "{}")]));
        chat.Entries.Add(new ActionRow("posed", "Move 0003 to review", "Runs move_card in wilson as you. Expires in 10 minutes.", """{"id":"0003","stage":"review"}""", "pending", true, false, null));
        chat.Entries.Add(new ActionRow("posed-2", "Merge 0002", "Runs merge_card in wilson as you.", """{"id":"0002"}""", "failed", false, true, "cannot merge 0002: it is in \"planning\", not \"ready\""));
        walk.Shot("14b-chat-actions");

        walk.Shell.ShowBoardCommand.Execute(null);
        walk.Page<BoardViewModel>();
        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("back on the same chat", () => walk.Shell.Page == home && home.Chat == chat && chat.Entries.Count > 0);

        var current = home.Threads.First(thread => thread.Current);
        home.AskRename(current);
        home.NewTitle = "Walked chat";
        walk.Shot("15-rename");
        await home.SaveRenameCommand.ExecuteAsync(null);
        await walk.UntilAsync("the new name in the rail", () => home.Threads.Any(thread => thread.Current && thread.Title == "Walked chat"));

        await home.ArchiveCommand.ExecuteAsync(home.Threads.First(thread => thread.Current));
        await walk.UntilAsync("archiving it opening a new chat", () => home.Chat is { Empty: true } && home.Threads.All(thread => thread.Title != "Walked chat"));
        walk.Shot("16-after-archive");
    }
}
