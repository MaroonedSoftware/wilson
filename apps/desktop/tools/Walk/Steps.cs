using Avalonia.Input.Platform;
using Avalonia.Platform;
using Avalonia.Media.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Styling;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Board;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Desktop.Core.Settings;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Desktop.ViewModels;
using MaroonedSoftware.Wilson.Desktop.Views;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace Walk;

/// <summary>The flows, in the order a person would meet them.</summary>
internal static class Steps
{
    /// <summary>The panel the menu bar icon opens, on spending written as stages would write it. The icon itself needs a real window.</summary>
    private static async Task MenuBarAsync(Walker walk)
    {
        var panel = new MenuBarViewModel(walk.Shell, () => { }, () => { });
        var view = new MenuBarView { DataContext = panel };
        walk.ShotOf(view, "menubar-signed-out-or-empty", 300, 720);

        var project = Walker.Query("select name from wilson.projects limit 1");
        var card = Walker.Query($"select id from wilson.cards where project = '{project}' limit 1");
        Walker.Sql(
            "insert into wilson.card_events (project, card_id, stage, type, payload, created_at) "
            + $"select '{project}', '{card}', 'implementing', case when day % 4 = 0 then 'stage.failed' else 'stage.passed' end, "
            + "jsonb_build_object('usage', jsonb_build_object('inputTokens', 4000 + day * 900, 'cachedInputTokens', 20000 + day * 7000, 'outputTokens', 3000 + ((day * 7919) % 14) * 2600)), "
            + "now() - make_interval(days => day) from generate_series(0, 12) as day");

        panel.Shown();
        await walk.UntilAsync("the panel's figures", () => panel.HasFigures && panel.Bars.Count == MenuBarViewModel.WindowDays);
        await walk.UntilAsync("spending in the bars", () => panel.Bars.Any(bar => bar.Height > 0));
        Console.WriteLine($"     menu bar: passed {panel.Passed.Value}, cached {panel.Cached.Value}, slots {panel.Slots.Value}");
        walk.ShotOf(new MenuBarView { DataContext = panel }, "menubar-figures", 300, 720);
        panel.Hidden();

        // Two accounts in rotation, the first at its limit, and a limit left on this server's own sign-in,
        // which no engine uses while the rotation has accounts. The ciphertext is never read by a listing.
        Walker.Sql(
            "insert into wilson.engine_tokens (name, ciphertext, pooled, priority) values "
            + "('walk-pool-a', 'not-a-token', true, 0), ('walk-second', 'not-a-token', true, 1)");
        Walker.Sql(
            "insert into wilson.engine_limits (account, limit_type, resets_at) values "
            + "('walk-pool-a', 'seven_day', now() + interval '5 hours'), ('local', 'seven_day', now() + interval '2 hours')");
        // Spend charged to the second account, today and a week ago, so its row says what it spent.
        Walker.Sql(
            "insert into wilson.card_events (project, card_id, stage, type, payload, created_at) "
            + $"select '{project}', '{card}', 'implementing', 'stage.passed', "
            + "jsonb_build_object('account', 'walk-second', 'usage', jsonb_build_object('inputTokens', 1000, 'outputTokens', spent)), at "
            + "from (values (42000, now()), (1300000, now() - interval '7 days')) as spend(spent, at)");
        try
        {
            panel.Shown();
            await walk.UntilAsync("the accounts in rotation, with what they spent", () => panel.Accounts.Any(account => account.Name == "walk-second" && account.Spend?.Contains("today", StringComparison.Ordinal) == true));
            Console.WriteLine($"     accounts: {string.Join("; ", panel.Accounts.Select(account => $"{account.Name} = {account.Status} ({account.Spend})"))}");
            walk.ShotOf(new MenuBarView { DataContext = panel }, "menubar-accounts", 300, 720);
            panel.Hidden();
        }
        finally
        {
            Walker.Sql("delete from wilson.engine_limits where account in ('walk-pool-a', 'local')");
            Walker.Sql("delete from wilson.engine_tokens where name in ('walk-pool-a', 'walk-second')");
            Walker.Sql("delete from wilson.card_events where payload->>'account' = 'walk-second'");
        }
    }

    public static async Task RunAsync(Walker walk, string origin, string email, string password, string? only = null)
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
        var signedIn = DateTime.UtcNow;
        if (only == "apps")
        {
            await AppsAsync(walk);
            return;
        }

        if (only == "menubar")
        {
            await MenuBarAsync(walk);
            return;
        }

        if (only == "images")
        {
            await ChatImagesAsync(walk, home);
            return;
        }

        if (only == "actions")
        {
            await ChatActionsAsync(walk, home);
            return;
        }

        if (only == "dock")
        {
            await DockByDefaultAsync(walk);
            await DockAsync(walk);
            return;
        }

        if (only == "admin")
        {
            await AdminAsync(walk);
            await SecurityAsync(walk, email, password, signedIn);
            return;
        }

        if (only == "lanes")
        {
            await LanesAsync(walk);
            await LaneRoutingAsync(walk);
            await LaneStepUpAsync(walk, password, signedIn);
            return;
        }

        if (only == "merge")
        {
            await MergeStatusAsync(walk);
            return;
        }

        if (only == "question")
        {
            await QuestionAsync(walk);
            return;
        }

        if (only == "plan")
        {
            await PlanOnlyAsync(walk);
            return;
        }

        if (only == "goals")
        {
            await GoalsAsync(walk);
            return;
        }

        await AppearanceAsync(walk);
        walk.Shell.ShowBoardCommand.Execute(null);

        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("columns", () => board.Columns.Count > 0);
        await walk.UntilAsync("the feed live in the header", () => walk.Shell.OnBoard && walk.Shell.Feed is { Live: true });
        walk.Shot("03-board");
        await ProjectsAsync(walk, board);
        await GoalsAsync(walk);
        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("back on the same board", () => walk.Shell.Page == board && board.Live);
        await FlaggedAsync(walk, board);
        await ActivityAsync(walk, board);
        await FilterAsync(walk, board);
        await ToolActivityAsync(walk, board);

        await DiffAsync(walk, board);
        await FindingsAsync(walk, board);
        await CardsAsync(walk, board);
        await AdminAsync(walk);
        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("back on chat", () => walk.Shell.Page == home);
        await ChatAsync(walk, home);
        await SecurityAsync(walk, email, password, signedIn);

        await walk.Shell.SignOutCommand.ExecuteAsync(null);
        await walk.UntilAsync("signing out from the header", () => walk.Shell.Page is SignInViewModel && !walk.Shell.SignedIn);
    }

    /// <summary>
    /// Making the one account, which needs an API on a database with none: not the seeded one, whose
    /// operator already exists. Run with `firstrun` against one made for the purpose.
    /// </summary>
    public static async Task FirstRunAsync(Walker walk, string origin, string email, string password)
    {
        await walk.UntilAsync("the welcome", () => walk.Shell.Page is SignInViewModel { Welcoming: true });
        var signIn = walk.Page<SignInViewModel>();
        signIn.Start();
        signIn.Address = origin;
        await signIn.CheckAsync();
        await walk.UntilAsync("the server with no account asking for one", () => signIn.CreatingAccount);
        walk.Shot("00-account");

        signIn.Email = email;
        signIn.Password = password;
        signIn.Confirmation = "something else";
        await signIn.CreateAccountCommand.ExecuteAsync(null);
        await walk.UntilAsync("passwords that differ refused", () => signIn.Error == "The passwords do not match.");

        signIn.Password = "password";
        signIn.Confirmation = "password";
        await signIn.CreateAccountCommand.ExecuteAsync(null);
        await walk.UntilAsync("an easy password refused, with advice", () => signIn.Error?.StartsWith("That password is too easy", StringComparison.Ordinal) == true);
        Console.WriteLine($"     refused: {signIn.Error}");
        walk.Shot("00-account-refused");

        signIn.Password = password;
        signIn.Confirmation = password;
        await signIn.CreateAccountCommand.ExecuteAsync(null);
        await walk.UntilAsync("the account made and signed in", () => walk.Shell.Page is ThreadsViewModel);
        walk.Shot("00-account-done");

        await walk.Shell.SignOutCommand.ExecuteAsync(null);
        await walk.UntilAsync("the server now asking for a password", () => walk.Shell.Page is SignInViewModel { ShowsPasswordStep: true });
    }

    /// <summary>The list and the page around an app, headless, so with no web view in it: `app-live` walks that in a real window.</summary>
    private static async Task AppsAsync(Walker walk)
    {
        var apps = walk.Shell.Connection!.Sdk.Apps;
        walk.Shell.ShowBoard();
        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("the board", () => board.Project is not null);
        walk.Shell.ShowApps();
        var empty = walk.Page<AppsViewModel>();
        await walk.UntilAsync("no apps said", () => empty.Empty);
        walk.Shot("apps-none");
        walk.Shell.Back();

        await apps.InstallAppAsync("walk-one", new InstallAppRequest { Name = "Burn down", Description = "What is left, by day", Html = "<p>one</p>", Grants = [AppGrant.BoardRead, AppGrant.StatsRead] });
        await apps.InstallAppAsync("walk-two", new InstallAppRequest { Name = "No grants", Html = "<p>two</p>", Grants = [] });
        try
        {
            walk.Shell.ShowApps();
            var list = walk.Page<AppsViewModel>();
            await walk.UntilAsync("both listed", () => list.Apps.Count == 2);
            walk.Shot("apps-list");
            list.Open("walk-one");
            var page = walk.Page<AppViewModel>();
            await walk.UntilAsync("the app read", () => page.Running);
            walk.Shot("apps-page");
            walk.Shell.Back();
            await walk.UntilAsync("back on the list", () => walk.Shell.Page is AppsViewModel);
        }
        finally
        {
            await apps.RemoveAppAsync("walk-one");
            await apps.RemoveAppAsync("walk-two");
        }

        var missing = new AppViewModel(walk.Shell, board.Project!, "walk-one");
        walk.Shell.Push(missing);
        await walk.UntilAsync("an app that has gone said", () => missing.Error is not null);
        walk.Shot("apps-gone");
        walk.Shell.Back();
    }

    /// <summary>The deployment's own pages, which need no board. `admin` as a sixth argument walks only these.</summary>
    private static async Task AdminAsync(Walker walk)
    {
        await LanesAsync(walk);
        await LaneRoutingAsync(walk);
        await HostsAsync(walk);
        await SettingsAsync(walk);
        await DockAsync(walk);
    }

    /// <summary>A lane's instructions and settings saved, read back from a fresh page and put back, with a box that cannot be read and a value the API refuses.</summary>
    /// <summary>What Merge would do, on the board and on the card. Needs a card in `ready`; the API works out the rest from its code repo.</summary>
    private static async Task MergeStatusAsync(Walker walk)
    {
        walk.Shell.ShowBoardCommand.Execute(null);
        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("a ready card with a merge status", () => board.Columns.Any(column => column.Cards.Any(tile => tile.MergeStatus is not null)));
        var tiles = board.Columns.SelectMany(column => column.Cards).Where(tile => tile.MergeStatus is not null).ToList();
        foreach (var tile in tiles)
        {
            Console.WriteLine($"     {tile.Card.Id}: {tile.MergeStatus}");
        }

        // Everything else folded, or `ready` sits past the edge of the shot.
        foreach (var column in board.Columns.Where(column => !column.Cards.Any(tile => tile.MergeStatus is not null)).ToList())
        {
            board.ToggleCollapsedCommand.Execute(column);
        }

        await Task.Delay(300);
        walk.Shot("03-merge-status-board");

        board.OpenCard(tiles.FirstOrDefault(tile => tile.MergeStatusWarns)?.Card ?? tiles[0].Card);
        var card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the card's merge status", () => card.MergeStatus is not null);
        walk.Shot("03-merge-status-card");
    }

    /// <summary>
    /// Answers a question a stage asked. Getting one takes a real run, or setting `blocked` and
    /// `needs_human` on a card in the throwaway database, so this walks only a board that has one.
    /// </summary>
    private static async Task QuestionAsync(Walker walk)
    {
        walk.Shell.ShowBoardCommand.Execute(null);
        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("columns", () => board.Columns.Count > 0);
        await walk.UntilAsync("a card with a question", () => board.Columns.SelectMany(column => column.Cards).Any(tile => tile.Card.Blocked is not null));
        board.OpenCard(board.Columns.SelectMany(column => column.Cards).First(tile => tile.Card.Blocked is not null).Card);

        var card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the question read", () => card.Question is not null);
        walk.Shot("16-question");

        var option = card.Question!.Options![1];
        card.UseOptionCommand.Execute(option);
        await walk.UntilAsync("the likely answer in the box", () => card.Answer == option);
        walk.Shot("16-question-filled");

        await card.SendAnswerCommand.ExecuteAsync(null);
        await walk.UntilAsync("the question gone, and the box empty", () => card.Question is null && card.Answer.Length == 0 && card.FlagReason is null);
        Console.WriteLine($"     notice: {card.Notice}");
        walk.Shot("16-question-answered");
    }

    private static async Task LanesAsync(Walker walk)
    {
        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("a board to open lanes from", () => walk.Shell.Feed?.Project is not null);
        var from = walk.Shell.Page;
        walk.Shell.ShowLanesCommand.Execute(null);
        var page = walk.Page<LanesViewModel>();
        await walk.UntilAsync("the project's lanes read", () => page.Rows.Count > 0);
        Console.WriteLine($"     lanes of {page.Project}: {string.Join(", ", page.Rows.Select(row => row.Name))}");
        walk.Shot("15-lanes");

        var lane = page.Rows.Single(row => row.Name == "implementing");
        var (instructions, settings) = (lane.Instructions, lane.Settings);
        await walk.UntilAsync("nothing to save yet", () => !lane.CanSave);

        lane.Settings = "{not json";
        await walk.UntilAsync("a box that cannot be read, saying so", () => lane.SettingsProblem is not null && !lane.CanSave);
        Console.WriteLine($"     problem: {lane.SettingsProblem}");
        walk.Shot("15-lanes-problem");

        lane.Settings = """{"maxSteps":"many"}""";
        await lane.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a value refused, the attempt kept", () => lane.Error is not null && lane.Settings == """{"maxSteps":"many"}""");
        Console.WriteLine($"     refused: {lane.Error}");
        walk.Shot("15-lanes-refused");

        lane.Settings = settings;
        lane.Instructions = "Walked instructions.";
        await lane.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("instructions saved", () => lane.Stored.Instructions == "Walked instructions." && lane.Error is null && !lane.CanSave);

        using (var edited = JsonDocument.Parse(settings!))
        {
            var kept = edited.RootElement.EnumerateObject().Where(key => key.Name != "maxOutputTokens").Select(key => $"\"{key.Name}\":{key.Value.GetRawText()}");
            lane.Settings = $"{{{string.Join(',', kept)},\"placement\":\"any\"}}";
        }

        await lane.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a key removed and one added", () => lane.Error is null && !lane.CanSave && lane.Settings!.Contains("placement", StringComparison.Ordinal) && !lane.Settings.Contains("maxOutputTokens", StringComparison.Ordinal));

        walk.Shell.BackCommand.Execute(null);
        await walk.UntilAsync("Back returning to the board", () => walk.Shell.Page == from);
        walk.Shell.ShowLanesCommand.Execute(null);
        var again = walk.Page<LanesViewModel>();
        await walk.UntilAsync("a fresh page reading the same", () => again.Rows.Any(row => row.Name == "implementing" && row.Instructions == "Walked instructions." && row.Settings!.Contains("placement", StringComparison.Ordinal)));
        walk.Shot("15-lanes-saved");

        var back = again.Rows.Single(row => row.Name == "implementing");
        back.Instructions = instructions;
        back.Settings = settings;
        await back.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the lane put back", () => back.Error is null && !back.CanSave && back.Stored.Instructions == instructions && back.Settings == settings);
        walk.Shell.BackCommand.Execute(null);
    }

    /// <summary>Routing changed on a second project's Lanes page, reaching that project alone: the default project's reads the same.</summary>
    private static async Task LaneRoutingAsync(Walker walk)
    {
        var connection = walk.Shell.Connection!;
        var home = walk.Shell.Feed!.Project!;
        // Sorts after the seeded project, as a first project with no cards would break the steps that take the first one.
        var other = $"zz-walked-routes-{DateTime.UtcNow:HHmmss}";
        var root = Walker.Query("select code_root from wilson.projects order by name limit 1");
        await connection.Sdk.Projects.RegisterProjectAsync(new CreateProjectRequest { Name = other, CodeRoot = root, WorktreeRoot = $"{root}/.worktrees/{other}", RunRoot = $"{root}/.runs/{other}" });
        using (var sdk = connection.ForProject(other))
        {
            await sdk.Board.InitialiseBoardAsync();
        }

        static async Task<string?> ModelOf(MaroonedSoftware.Wilson.Sdk.WilsonSdk sdk) => (await sdk.Stages.ListStageRoutingAsync()).Single(route => route.Stage == "implementing").Model;

        using var homeSdk = connection.ForProject(home);
        var homeModel = await ModelOf(homeSdk);

        await walk.Shell.ProjectAddedAsync(other);
        await walk.UntilAsync("the second project's board", () => walk.Shell.Feed?.Project == other);
        walk.Shell.ShowLanesCommand.Execute(null);
        var page = walk.Page<LanesViewModel>();
        await walk.UntilAsync("that project's routing read", () => page.Project == other && page.Routing.Rows.Count > 0);
        Console.WriteLine($"     lanes of {page.Project}: {string.Join(", ", page.Routing.Rows.Select(row => $"{row.Stage}={row.Adapter}/{row.Provider}/{row.Model}"))}");
        walk.Shot("15-lanes-routing");

        var route = page.Routing.Rows.Single(row => row.Stage == "implementing");
        route.Model = "walked-other-project";
        await route.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a model saved on that project", () => route.Stored.Model == "walked-other-project" && route.Error is null);

        using (var sdk = connection.ForProject(other))
        {
            var (there, here) = (await ModelOf(sdk), await ModelOf(homeSdk));
            Console.WriteLine($"     {other}: {there}, {home}: {here}");
            if (there != "walked-other-project" || here != homeModel)
            {
                throw new InvalidOperationException($"Routing reached the wrong project: {other} has {there}, {home} has {here}, was {homeModel}");
            }
        }

        walk.Shell.BackCommand.Execute(null);
        walk.Shell.ShowProject(home);
        await walk.UntilAsync("the first project's board again", () => walk.Shell.Feed?.Project == home);
    }

    /// <summary>A lane saved on a session old enough to need a step-up: the real prompt, answered, and the save replayed on the project's own client.</summary>
    private static async Task LaneStepUpAsync(Walker walk, string password, DateTime signedIn)
    {
        var old = signedIn.AddMinutes(5.2) - DateTime.UtcNow;
        if (old > TimeSpan.Zero)
        {
            Console.WriteLine($"     waiting {old.TotalSeconds:F0}s for the session to need a step-up");
            await Task.Delay(old);
        }

        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("a board to open lanes from", () => walk.Shell.Feed?.Project is not null);
        walk.Shell.ShowLanesCommand.Execute(null);
        var page = walk.Page<LanesViewModel>();
        await walk.UntilAsync("the lanes read", () => page.Rows.Count > 0);

        var route = page.Routing.Rows.Single(row => row.Stage == "implementing");
        var model = route.Model;
        route.Model = "walked-behind-a-step-up";
        _ = route.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a step-up asked by a route's save", () => walk.Shell.StepUp is not null);
        walk.Shell.StepUp!.CancelCommand.Execute(null);
        await walk.UntilAsync("cancelling leaving the route refused and the attempt kept", () => walk.Shell.StepUp is null && route.Idle && route.Error is not null && route.Stored.Model == model && route.Model == "walked-behind-a-step-up");
        Console.WriteLine($"     cancelled: {route.Error}");
        route.Model = model;

        var lane = page.Rows.Single(row => row.Name == "implementing");
        var instructions = lane.Instructions;
        lane.Instructions = "Walked behind a step-up.";
        _ = lane.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a step-up asked by the save", () => walk.Shell.StepUp is not null);
        walk.Shot("15-lanes-step-up");

        var stepUp = walk.Shell.StepUp!;
        stepUp.Password = password;
        await stepUp.SubmitCommand.ExecuteAsync(null);
        await walk.UntilAsync("the save replayed", () => walk.Shell.StepUp is null && lane.Idle && lane.Error is null && lane.Stored.Instructions == "Walked behind a step-up.");

        lane.Instructions = instructions;
        await lane.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the lane put back", () => lane.Error is null && lane.Stored.Instructions == instructions);
    }

    /// <summary>A first run, on a file that has never had the dock touched: chat fills the home page and is a sidebar everywhere else.</summary>
    private static async Task DockByDefaultAsync(Walker walk)
    {
        var home = walk.Page<ThreadsViewModel>();
        await walk.UntilAsync("no dock on the home page", () => walk.Shell.RightDock is null && walk.Shell.BottomDock is null);

        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("the same chat as a sidebar on the board", () => walk.Shell.RightDock?.Home == home && home.Chat is not null);
        await walk.UntilAsync("the board live beside it", () => walk.Shell.Feed?.Live == true, 20);
        walk.Shot("14-dock-by-default-board");
        walk.Shell.ShowSettingsCommand.Execute(null);
        await walk.UntilAsync("still a sidebar on settings", () => walk.Shell.RightDock is not null);
        walk.Shot("14-dock-by-default-settings");

        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("the home page again, with no dock", () => walk.Shell.Page == home && walk.Shell.RightDock is null);
        walk.Shot("14-dock-by-default-home");

        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("the sidebar back", () => walk.Shell.RightDock is not null);
        await walk.UntilAsync("the board live again", () => walk.Shell.Feed?.Live == true, 20);
        walk.Chord(PhysicalKey.J, RawInputModifiers.Meta);
        await walk.UntilAsync("closed by Cmd+J, kept", () => walk.Shell.RightDock is null && walk.Settings().Dock.Closed);
        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("home", () => walk.Shell.Page == home);
        walk.Shell.ShowBoardCommand.Execute(null);
        await walk.UntilAsync("staying closed across pages", () => walk.Shell.OnBoard && walk.Shell.RightDock is null);
    }

    /// <summary>The chat beside a page: by the real shortcut and a real drag, one real turn, and the same model on the home page.</summary>
    private static async Task DockAsync(Walker walk)
    {
        await walk.UntilAsync("on a page that takes the dock", () => walk.Shell.CanDock && !walk.Shell.DockOpen);
        walk.Chord(PhysicalKey.J, RawInputModifiers.Meta);
        await walk.UntilAsync("the dock open on the right by Cmd+J", () => walk.Shell.RightDock is { Home.Chat: not null } && walk.Settings().Dock.Open);
        var dock = walk.Shell.RightDock!;
        await walk.UntilAsync("the chats in its picker", () => dock.Home.Threads.Count > 0 || dock.Home.NoChats);
        walk.Shot("14-dock-right");

        var width = walk.Shell.Dock.Width;
        var handle = walk.CenterOf("RightHandle");
        walk.Drag(handle, handle - new Point(120, 0));
        await walk.UntilAsync("a drag widening it, kept", () => walk.Shell.Dock.Width > width + 100 && walk.Settings().Dock.Width == walk.Shell.Dock.Width);
        walk.Drag(walk.CenterOf("RightHandle"), new Point(1100, 300));
        await walk.UntilAsync("a drag stopped at the limit", () => walk.Shell.Dock.Width == ChatDock.MinWidth);

        dock.Home.NewChatCommand.Execute(null);
        var chat = dock.Home.Chat!;
        chat.Composer = "Say hello in three words.";
        await chat.SendCommand.ExecuteAsync(null);
        await walk.UntilAsync("a real turn answered in the dock", () => chat.Entries.OfType<AnswerEntry>().Any(), 120);
        await walk.UntilAsync("that chat picked", () => dock.Picked?.Id == chat.Id);
        walk.Shot("14-dock-turn");

        dock.MoveCommand.Execute(null);
        await walk.UntilAsync("the dock at the bottom, kept", () => walk.Shell.BottomDock is not null && walk.Shell.RightDock is null && walk.Settings().Dock.Position == ChatDockPosition.Bottom);
        walk.Shot("14-dock-bottom");
        var height = walk.Shell.Dock.Height;
        var bar = walk.CenterOf("BottomHandle");
        walk.Drag(bar, bar - new Point(0, 100));
        await walk.UntilAsync("a drag raising it", () => walk.Shell.Dock.Height > height + 80);

        if (dock.Home.Threads.FirstOrDefault(thread => thread.Id != chat.Id) is { } other)
        {
            dock.Picked = other;
            await walk.UntilAsync("another chat from the picker", () => dock.Home.Chat?.Id == other.Id);
            dock.Picked = dock.Home.Threads.First(thread => thread.Id == chat.Id);
            await walk.UntilAsync("that chat back", () => dock.Home.Chat?.Id == chat.Id);
        }

        var open = dock.Home.Chat;
        dock.OpenAsHomeCommand.Execute(null);
        await walk.UntilAsync("the home page showing the same chat, with no dock", () => walk.Shell.Page is ThreadsViewModel page && page.Chat == open && walk.Shell.BottomDock is null);
        walk.Chord(PhysicalKey.J, RawInputModifiers.Meta);
        await walk.UntilAsync("Cmd+J doing nothing on chat", () => walk.Shell.DockOpen);
        walk.Shell.ShowHostsCommand.Execute(null);
        await walk.UntilAsync("the dock back on another page", () => walk.Shell.BottomDock is not null);
        walk.Shell.BottomDock!.MoveCommand.Execute(null);
        walk.Shell.RightDock!.CloseCommand.Execute(null);
        await walk.UntilAsync("the dock closed, kept", () => walk.Shell.RightDock is null && !walk.Settings().Dock.Open);
    }

    /// <summary>
    /// Real writes on the throwaway API, each put back. Auto-mode is only flipped under a drain, because
    /// that API's poller is off so that nothing it holds ever starts work.
    /// </summary>
    private static async Task SettingsAsync(Walker walk)
    {
        walk.Shell.ShowSettingsCommand.Execute(null);
        var settings = walk.Page<SettingsViewModel>();
        await walk.UntilAsync("the settings read", () => settings.AutoMode.Loaded && settings.Drain.Loaded && settings.PollInterval.Loaded && settings.Facts.Count == 5 && settings.Webhook is not null);
        await walk.UntilAsync("the header marking Settings", () => walk.Shell.OnSettings);
        walk.Shot("12-settings");

        settings.Drain.On = true;
        await walk.UntilAsync("a drain, in the header too", () => walk.Shell.DrainBadge is not null && settings.Drain.Idle);
        Console.WriteLine($"     {walk.Shell.DrainBadge}: {walk.Shell.DrainLine}");
        walk.Shot("12-settings-drain");
        walk.Shell.ShowHostsCommand.Execute(null);
        await walk.UntilAsync("the header's drain on another page", () => walk.Shell.Page is HostsViewModel && walk.Shell.DrainBadge is not null);
        walk.Shell.ShowSettingsCommand.Execute(null);
        await walk.UntilAsync("the settings kept", () => walk.Shell.Page == settings);

        settings.AutoMode.On = true;
        await walk.UntilAsync("auto-mode on", () => settings.AutoMode.Idle && settings.AutoMode.On);
        settings.AutoMode.On = false;
        await walk.UntilAsync("auto-mode off again", () => settings.AutoMode.Idle && !settings.AutoMode.On);
        settings.Drain.On = false;
        await walk.UntilAsync("the drain lifted, and gone from the header", () => settings.Drain.Idle && walk.Shell.DrainBadge is null);

        var split = settings.AutoSplit.On;
        settings.AutoSplit.On = !split;
        await walk.UntilAsync("auto-split changed", () => settings.AutoSplit.Idle && settings.AutoSplit.On != split);
        settings.AutoSplit.On = split;
        await walk.UntilAsync("auto-split put back", () => settings.AutoSplit.Idle && settings.AutoSplit.On == split);

        var interval = settings.PollInterval.Stored;
        settings.PollInterval.Draft = 1;
        await settings.PollInterval.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("an interval refused and put back", () => settings.PollInterval.Error is not null && settings.PollInterval.Draft == interval);
        Console.WriteLine($"     refused: {settings.PollInterval.Error}");
        settings.PollInterval.Draft = 12_000;
        await settings.PollInterval.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("an interval saved", () => settings.PollInterval.Stored == 12_000 && !settings.PollInterval.Dirty);
        settings.PollInterval.Draft = interval;
        await settings.PollInterval.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the interval put back", () => settings.PollInterval.Stored == interval);

        var slots = settings.LocalSlots.Stored;
        settings.LocalSlots.Draft = slots == 1 ? 2 : 1;
        await settings.LocalSlots.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("local slots saved", () => settings.LocalSlots.Stored != slots);
        settings.LocalSlots.Draft = slots;
        await settings.LocalSlots.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("local slots put back", () => settings.LocalSlots.Stored == slots);

        settings.WebhookDraft = "http://localhost:9/hook";
        settings.BaseUrlDraft = "http://not checked";
        await settings.SaveWebhookCommand.ExecuteAsync(null);
        await walk.UntilAsync("a webhook refused, the attempt kept", () => settings.WebhookError is not null && settings.WebhookDraft == "http://localhost:9/hook" && settings.WebhookStillSaved is not null);
        Console.WriteLine($"     refused: {settings.WebhookError}");
        walk.Shot("12-settings-refused");
        settings.WebhookDraft = "https://example.com/hook";
        settings.BaseUrlDraft = "not checked at all";
        await settings.SaveWebhookCommand.ExecuteAsync(null);
        await walk.UntilAsync("a webhook saved, and the base URL as typed", () => settings.Webhook?.BaseUrl == "not checked at all" && settings.WebhookError is null);

        // The API answers 500 to a null in this request (`SettingsStore.set` of undefined), in the web app too, so this goes by hand.
        Walker.Sql("delete from wilson.settings where key in ('notify-webhook-url', 'notify-base-url')");

        await StageRoutingAsync(walk, settings);
        await EngineSettingsAsync(walk, settings);
    }

    /// <summary>A lane's model saved and put back, the AI SDK's provider shown, Codex fixing its provider, and a route the API refuses.</summary>
    private static async Task StageRoutingAsync(Walker walk, SettingsViewModel settings)
    {
        var routing = settings.StageRouting;
        await walk.UntilAsync("the stage routing read", () => routing.Rows.Count > 0);
        Console.WriteLine($"     lanes: {string.Join(", ", routing.Rows.Select(row => $"{row.Stage}={row.Adapter}/{row.Provider}/{row.Model}"))}");
        Console.WriteLine($"     shared: {routing.SharedProvider}");
        walk.ScrollTo("Stage routing");
        walk.Shot("12-stage-routing");

        var implementing = routing.Rows.Single(row => row.Stage == "implementing");
        var (adapter, provider, model) = (implementing.Adapter, implementing.Provider, implementing.Model);

        implementing.Model = "walk-model";
        await implementing.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a model saved", () => implementing.Stored.Model == "walk-model" && !implementing.CanSave && implementing.Error is null);

        implementing.UsesCodex = true;
        await walk.UntilAsync("Codex fixing the provider", () => implementing.Provider == StageRoutingProvider.Openai && !implementing.ChoosesProvider);

        implementing.UsesApi = true;
        await walk.UntilAsync("the AI SDK offering a provider", () => implementing.ChoosesProvider);
        walk.Shot("12-stage-routing-api");

        implementing.UsesCli = true;
        implementing.Provider = StageRoutingProvider.Openai;
        await implementing.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("Claude's engine on another provider refused, the attempt kept", () => implementing.Error is not null && implementing.Provider == StageRoutingProvider.Openai);
        Console.WriteLine($"     refused: {implementing.Error}");
        walk.Shot("12-stage-routing-refused");

        implementing.Adapter = adapter;
        implementing.Provider = provider;
        implementing.Model = model;
        await implementing.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the route put back", () => implementing.Stored.Model == model && implementing.Stored.Adapter == adapter && implementing.Stored.Provider == provider);

        // The seeded board has neither lane, so these two rows go in by hand and come out again. A lane read is cached until the next revision.
        const string revision = "insert into wilson.lane_revisions (project, lane, snapshot, message) values ('wilson', 'implementing', '{}', 'walk')";
        const string lanes = "('wilson', 'review', 3, 'agent', 'readonly', 'ready', 'implementing', 'api', 'anthropic', 'claude-sonnet-5', 'walk'), ('wilson', 'ready', 4, 'manual', 'none', 'done', 'implementing', null, null, null, 'walk')";
        Walker.Sql($"insert into wilson.lanes (project, name, position, mode, worktree, on_pass, on_fail, adapter, provider, model, instructions) values {lanes}");
        Walker.Sql("update wilson.lanes set on_pass = 'review' where project = 'wilson' and name = 'implementing'");
        Walker.Sql(revision);
        await routing.ReadAsync(CancellationToken.None);
        var review = routing.Rows.Single(row => row.Stage == "review");
        var ready = routing.Rows.Single(row => row.Stage == "ready");
        await walk.UntilAsync("sharing a provider said, and ready choosing only a model", () => routing.SharedProvider is not null && !ready.ChoosesAdapter && !ready.ChoosesProvider && ready.Placeholder is not null);
        Console.WriteLine($"     shared: {routing.SharedProvider}");
        walk.Shot("12-stage-routing-shared");

        review.UsesApi = true;
        review.Provider = StageRoutingProvider.Openai;
        await review.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a different provider ending the warning", () => routing.SharedProvider is null && review.Error is null);

        Walker.Sql("update wilson.lanes set on_pass = 'done' where project = 'wilson' and name = 'implementing'");
        Walker.Sql("delete from wilson.lanes where project = 'wilson' and name in ('review', 'ready')");
        Walker.Sql(revision);
        await routing.ReadAsync(CancellationToken.None);
    }

    /// <summary>
    /// A real authenticator on the throwaway operator, enrolled behind a real step-up and answered with
    /// real codes, then removed. Waits for the session to pass the five minutes the step-up allows. A
    /// failure here leaves the operator with a factor: see `Walker.Sql`.
    /// </summary>
    private static async Task SecurityAsync(Walker walk, string email, string password, DateTime signedIn)
    {
        var old = signedIn.AddMinutes(5.2) - DateTime.UtcNow;
        if (old > TimeSpan.Zero)
        {
            Console.WriteLine($"     waiting {old.TotalSeconds:F0}s for the session to need a step-up");
            await Task.Delay(old);
        }

        walk.Shell.ShowSettingsCommand.Execute(null);
        var settings = walk.Page<SettingsViewModel>();
        var security = settings.Security;
        await security.ReadAsync(CancellationToken.None);
        await walk.UntilAsync("no factor yet", () => security.CanSetUp && security.Factors.Count == 0);
        walk.ScrollTo("Security");
        walk.Shot("13-security");

        _ = security.StartCommand.ExecuteAsync(null);
        await walk.UntilAsync("a step-up asked, with the email filled in", () => walk.Shell.StepUp is { Email: not null });
        var stepUp = walk.Shell.StepUp!;
        stepUp.Password = "wrong";
        await stepUp.SubmitCommand.ExecuteAsync(null);
        await walk.UntilAsync("a wrong password refused", () => stepUp.Error == "Wrong email or password." && walk.Shell.StepUp == stepUp);
        walk.Shot("13-step-up");
        stepUp.CancelCommand.Execute(null);
        await walk.UntilAsync("cancelling leaving it refused", () => walk.Shell.StepUp is null && !security.Busy && security.Error is not null);
        Console.WriteLine($"     cancelled: {security.Error}");

        _ = security.StartCommand.ExecuteAsync(null);
        await walk.UntilAsync("a step-up asked again", () => walk.Shell.StepUp is not null);
        walk.Shell.StepUp!.Password = password;
        await walk.Shell.StepUp.SubmitCommand.ExecuteAsync(null);
        await walk.UntilAsync("the request replayed, and enrolment open", () => walk.Shell.StepUp is null && security.Enrolling && security.QrCode is not null && security.Secret is not null);
        walk.ScrollTo("Security");
        walk.Shot("13-security-enrolling");

        var secret = security.Secret!;
        security.Code = "000000";
        await security.VerifyCommand.ExecuteAsync(null);
        await walk.UntilAsync("a wrong code refused", () => security.Error is not null && security.Enrolling);
        Console.WriteLine($"     refused: {security.Error}");
        security.Code = Walker.Totp(secret);
        await security.VerifyCommand.ExecuteAsync(null);
        await walk.UntilAsync("an authenticator on", () => security.HasAuthenticator && !security.Enrolling && security.Factors.Count == 1);
        walk.ScrollTo("Security");
        walk.Shot("13-security-on");

        await walk.Shell.SignOutCommand.ExecuteAsync(null);
        await walk.UntilAsync("signed out", () => walk.Shell.Page is SignInViewModel);
        var signIn = walk.Page<SignInViewModel>();
        signIn.Email = email;
        signIn.Password = password;
        await signIn.SubmitCommand.ExecuteAsync(null);
        await walk.UntilAsync("the code step for real", () => signIn.NeedsCode);
        signIn.Code = "000000";
        await signIn.SubmitCommand.ExecuteAsync(null);
        await walk.UntilAsync("a wrong code refused at sign-in", () => signIn.Error is not null);

        // A code answers once, and enrolling spent this period's.
        await Task.Delay(TimeSpan.FromSeconds(31 - (DateTimeOffset.UtcNow.ToUnixTimeSeconds() % 30)));
        signIn.Code = Walker.Totp(secret);
        await signIn.SubmitCommand.ExecuteAsync(null);
        await walk.UntilAsync("signed in with a real code", () => walk.Shell.Page is ThreadsViewModel, 10);

        walk.Shell.ShowSettingsCommand.Execute(null);
        var again = walk.Page<SettingsViewModel>().Security;
        await walk.UntilAsync("the authenticator listed", () => again.Factors.Count == 1);
        await again.RemoveCommand.ExecuteAsync(again.Factors[0]);
        await walk.UntilAsync("the authenticator removed", () => again.Factors.Count == 0 && !again.Busy && walk.Shell.StepUp is null);
    }

    /// <summary>Tokens made up for the walk, saved on the throwaway API and removed, so they sign nothing in.</summary>
    private static async Task EngineSettingsAsync(Walker walk, SettingsViewModel settings)
    {
        await walk.UntilAsync("the engine settings read", () => settings.ClaudeConfigDir.Loaded && settings.GitHubApp.Loaded && settings.ChatEngine.Loaded && settings.MachineSignIn.Source is not null && settings.GitHubKey is not null);
        var dir = settings.ClaudeConfigDir.Stored;
        settings.ClaudeConfigDir.Draft = "not/absolute";
        await settings.ClaudeConfigDir.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a config directory answered", () => settings.ClaudeConfigDir.Idle);
        Console.WriteLine($"     config dir: stored {settings.ClaudeConfigDir.Stored}, error {settings.ClaudeConfigDir.Error}");
        settings.ClaudeConfigDir.Draft = dir;
        if (settings.ClaudeConfigDir.Stored != dir)
        {
            Walker.Sql("delete from wilson.settings where key = 'claude-config-dir'");
        }

        var machine = settings.MachineSignIn;
        var source = machine.Setting!.Source;
        machine.AskEditCommand.Execute(null);
        machine.Draft = "two words";
        await machine.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a token with a space refused, the attempt kept", () => machine.Error is not null && machine.Draft == "two words" && machine.Editing);
        machine.Draft = "walked-not-a-token";
        await machine.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a token saved, and the box emptied and closed", () => machine.CanRemove && machine.Draft is null && !machine.Editing);

        var accounts = settings.Accounts;
        await walk.UntilAsync("no accounts in rotation said", () => accounts.Headline == "No accounts in rotation");
        async Task AddAsync(string name, AccountType type, bool joining)
        {
            accounts.AskAddCommand.Execute(null);
            accounts.NewType = type;
            accounts.NewName = name;
            accounts.NewToken = "walked-not-a-token";
            accounts.JoinRotation = joining;
            await accounts.SaveNewCommand.ExecuteAsync(null);
            await walk.UntilAsync($"{name} added, and the form closed", () => !accounts.Adding && accounts.NewToken is null && accounts.Idle);
        }

        await AddAsync("walked-first", AccountRules.Types[0], true);
        await AddAsync("walked-second", AccountRules.Types[0], true);
        await AddAsync("walked-key", AccountRules.Types[1], true);
        await AddAsync("walked-held", AccountRules.Types[0], false);
        await walk.UntilAsync("the accounts grouped", () => accounts.Rotation.Select(row => row.Name).SequenceEqual(["walked-first", "walked-second", "walked-key"]) && accounts.Outside.Any(row => row.Name == "walked-held"));
        await walk.UntilAsync("this machine's sign-in said to be unused", () => machine.Unused);

        accounts.AskAddCommand.Execute(null);
        accounts.NewName = "walked-first";
        accounts.NewToken = "walked-not-a-token";
        await walk.UntilAsync("a name already saved refused", () => accounts.NameTaken && !accounts.CanSaveNew);
        accounts.CancelAddCommand.Execute(null);

        await accounts.Rotation[2].MoveUpCommand.ExecuteAsync(null);
        await walk.UntilAsync("an account moved up", () => accounts.Rotation.Select(row => row.Name).SequenceEqual(["walked-first", "walked-key", "walked-second"]) && accounts.Idle);
        await walk.UntilAsync("the top account next, and nothing moving off either end", () => accounts.Rotation[0].Next && !accounts.Rotation[0].CanMoveUp && !accounts.Rotation[2].CanMoveDown);

        Walker.Sql("insert into wilson.engine_limits (account, limit_type, resets_at) values ('walked-first', 'seven_day', now() + interval '2 days')");
        await accounts.ReadAsync(CancellationToken.None);
        await walk.UntilAsync("the next account is the first free", () => accounts.Headline == "Next engine signs in as walked-key" && accounts.Rotation[1].Next && accounts.Rotation[0].Limit is not null);
        accounts.Rotation[1].AskReplaceCommand.Execute(null);
        accounts.Rotation[1].Replacement = "walked-not-a-token";
        accounts.Rotation[2].AskRemoveCommand.Execute(null);
        walk.ScrollTo("Accounts");
        walk.Shot("12-settings-accounts");
        walk.ScrollTo("This server's own sign-in");
        walk.Shot("12-settings-sign-in");

        machine.AskRemoveCommand.Execute(null);
        await machine.RemoveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the token removed", () => machine.Setting?.Source == source);

        await accounts.Rotation[1].SaveReplacementCommand.ExecuteAsync(null);
        await walk.UntilAsync("a token replaced, the name kept", () => accounts.Rotation.Any(row => row.Name == "walked-key" && !row.Replacing));
        foreach (var name in new[] { "walked-first", "walked-second", "walked-key", "walked-held" })
        {
            var row = accounts.Rotation.Concat(accounts.Outside).First(each => each.Name == name);
            row.AskRemoveCommand.Execute(null);
            await row.RemoveCommand.ExecuteAsync(null);
        }

        await walk.UntilAsync("the accounts gone", () => accounts.Rotation.Count == 0 && accounts.Outside.Count == 0 && accounts.Headline == "No accounts in rotation");

        accounts.AskAddCommand.Execute(null);
        await walk.UntilAsync("a free name offered, and signing in possible", () => accounts.NewName == "claude-1" && accounts.CanSignIn);
        var stopped = accounts.SignInCommand.ExecuteAsync(null);
        await walk.UntilAsync("a sign-in waiting, with its link", () => accounts.SigningIn && accounts.SignInLink is not null);
        walk.ScrollTo("Accounts");
        walk.Shot("12-settings-signing-in");
        accounts.StopSignInCommand.Execute(null);
        await stopped;
        await walk.UntilAsync("a sign-in stopped, saying nothing and saving nothing", () => !accounts.SigningIn && accounts.Idle && accounts.AddError is null && accounts.Adding && accounts.Rotation.Count == 0);
        walk.Shot("12-settings-add-account");
        await accounts.SignInCommand.ExecuteAsync(null);
        await walk.UntilAsync("a sign-in saved as an account, and the form closed", () => accounts.Rotation.Any(row => row.Name == "claude-1") && !accounts.Adding && accounts.NewToken is null);
        await accounts.Rotation[0].RemoveCommand.ExecuteAsync(null);
        await walk.UntilAsync("that account gone", () => accounts.Rotation.Count == 0);

        var app = settings.GitHubApp.Stored;
        settings.GitHubApp.Draft = "424242";
        await settings.GitHubApp.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("an app id saved", () => settings.GitHubApp.Stored == "424242");
        Console.WriteLine($"     key: {settings.GitHubKey}");
        if (app is null)
        {
            Walker.Sql("delete from wilson.settings where key = 'github-app-id'");
        }

        var chat = settings.ChatEngine.Stored!;
        settings.ChatEngine.UsesApi = true;
        settings.ChatEngine.Provider = MaroonedSoftware.Wilson.Sdk.Models.ChatEngineSettingProvider.Openai;
        settings.ChatEngine.Model = "walked-model";
        await walk.UntilAsync("the draft differing", () => settings.ChatEngine.Dirty);
        walk.ScrollTo("GitHub");
        walk.Shot("12-settings-chat");
        await settings.ChatEngine.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the chat engine answered", () => settings.ChatEngine.Idle);
        Console.WriteLine($"     chat: {settings.ChatEngine.Stored} error {settings.ChatEngine.Error}");
        settings.ChatEngine.Engine = chat.Engine;
        settings.ChatEngine.Provider = chat.Provider;
        settings.ChatEngine.Model = chat.Model;
        await settings.ChatEngine.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the chat engine put back", () => settings.ChatEngine.Stored == chat);
    }

    /// <summary>
    /// The goals page under the header: none, then goals written to the throwaway database and found by the
    /// page's own reading, open first and finished under their heading, each newest first, in both
    /// appearances. Each goal has a thread of its own, archived, and its wake-ups held, so no agent turn runs.
    /// </summary>
    private static async Task GoalsAsync(Walker walk)
    {
        const string Walked = "walk-goal-";
        Walker.Sql($"delete from wilson.chat_threads where title like '{Walked}%'");
        walk.Shell.ShowGoalsCommand.Execute(null);
        var goals = walk.Page<GoalsViewModel>();
        await walk.UntilAsync("the goals read, under Goals, a section with no Back", () => !goals.Loading && walk.Shell.OnGoals && !walk.Shell.CanGoBack);
        if (goals.NoGoals)
        {
            walk.Shot("12-goals-none");
        }
        else
        {
            Console.WriteLine($"     goals: {goals.Open.Count + goals.Finished.Count} already there, so the empty state was not drawn");
        }

        var project = Walker.Query("select name from wilson.projects order by name limit 1");
        Walker.Sql(
            "with made as (insert into wilson.chat_threads (title, engine, archived_at) "
            + $"select '{Walked}' || n, 'cli', now() from generate_series(1, 4) as n returning id, title) "
            + "insert into wilson.goals (thread_id, project, title, outcome, status, wake_held_until, updated_at) "
            + $"select made.id, '{project}', goal.title, goal.outcome, goal.status, now() + interval '1 day', now() - make_interval(mins => goal.age) "
            + "from made join (values "
            + $"('{Walked}1', 'Walk: desktop shows goals', 'The desktop app lists goals the way the web app does.', 'active', 1), "
            + $"('{Walked}2', 'Walk: paused while the API settles', 'Wait for the contract to stop moving.', 'paused', 5), "
            + $"('{Walked}3', 'Walk: first goal, finished', 'Done, and merged.', 'done', 30), "
            + $"('{Walked}4', 'Walk: an idea let go', 'Not worth the cards it would take.', 'abandoned', 60)"
            + ") as goal(thread, title, outcome, status, age) on goal.thread = made.title");
        var original = walk.Shell.Appearance;
        try
        {
            await walk.UntilAsync(
                "the walk's goals found by the page's own reading",
                () => goals.Open.Count(row => row.Title.StartsWith("Walk:", StringComparison.Ordinal)) == 2 && goals.Finished.Count(row => row.Title.StartsWith("Walk:", StringComparison.Ordinal)) == 2,
                seconds: 30);
            var open = goals.Open.Where(row => row.Title.StartsWith("Walk:", StringComparison.Ordinal)).ToList();
            var finished = goals.Finished.Where(row => row.Title.StartsWith("Walk:", StringComparison.Ordinal)).ToList();
            if (open[0].Status != "active" || !open[0].Active || open[1].Status != "paused" || !open[1].Paused
                || finished[0].Status != "done" || !finished[0].Done || finished[1].Status != "abandoned" || !finished[1].Abandoned
                || open[0].Project != project)
            {
                throw new InvalidOperationException($"goals out of order or mislabelled: {string.Join(", ", open.Concat(finished).Select(row => $"{row.Title} {row.Status} {row.Project}"))}");
            }

            Console.WriteLine($"     goals: open {string.Join(", ", goals.Open.Select(row => row.Status))}; finished {string.Join(", ", goals.Finished.Select(row => row.Status))}");
            foreach (var appearance in new[] { Appearance.Light, Appearance.Dark })
            {
                await AppearAsync(walk, appearance);
                walk.Shot($"12-goals-{appearance.ToString().ToLowerInvariant()}");
            }
        }
        finally
        {
            Walker.Sql($"delete from wilson.chat_threads where title like '{Walked}%'");
            await AppearAsync(walk, original);
        }

        await walk.UntilAsync("the walk's goals gone on a later reading", () => goals.Open.Concat(goals.Finished).All(row => !row.Title.StartsWith("Walk:", StringComparison.Ordinal)), seconds: 30);
    }

    /// <summary>Presses the header's appearance button until the app is drawn as asked.</summary>
    private static async Task AppearAsync(Walker walk, Appearance appearance)
    {
        while (walk.Shell.Appearance != appearance)
        {
            walk.Shell.NextAppearanceCommand.Execute(null);
        }

        var variant = appearance switch
        {
            Appearance.Light => ThemeVariant.Light,
            Appearance.Dark => ThemeVariant.Dark,
            _ => ThemeVariant.Default,
        };
        await walk.UntilAsync($"the app drawn {appearance}", () => Application.Current!.RequestedThemeVariant == variant);
    }

    /// <summary>
    /// Real writes on the throwaway API: a host registered, refused, drained, disabled, serving a project,
    /// an engine token assigned to a worker, a real probe failing, and both removed. A running slot is a
    /// row written by hand. Nothing here reaches a machine: the target does not resolve.
    /// </summary>
    private static async Task HostsAsync(Walker walk)
    {
        var stamp = DateTime.UtcNow.ToString("HHmmss", System.Globalization.CultureInfo.InvariantCulture);
        var (name, worker, token) = ($"walked-{stamp}", $"walked-w{stamp}", $"walked-t{stamp}");
        walk.Shell.ShowHostsCommand.Execute(null);
        var hosts = walk.Page<HostsViewModel>();
        await walk.UntilAsync("the hosts read", () => hosts.NoHosts || hosts.Hosts.Count > 0);
        await walk.UntilAsync("the header marking Hosts", () => walk.Shell.OnHosts);
        walk.Shot("11-hosts-none");

        hosts.Name = name;
        hosts.SshTarget = "walked.invalid";
        hosts.Slots = 2;
        hosts.CommandEnv = "WALKED_ONE, WALKED_TWO";
        await hosts.RegisterCommand.ExecuteAsync(null);
        await walk.UntilAsync("a host registered and the form cleared", () => hosts.Hosts.Any(panel => panel.Name == name) && hosts.Name is null);
        hosts.Name = name;
        await hosts.RegisterCommand.ExecuteAsync(null);
        await walk.UntilAsync("a taken name refused", () => hosts.RegisterError is not null);
        Console.WriteLine($"     refused: {hosts.RegisterError}");
        walk.Shot("11-hosts-refused");
        hosts.Name = null;
        hosts.RegisterError = null;

        var panel = hosts.Hosts.First(found => found.Name == name);
        await panel.ToggleDrainCommand.ExecuteAsync(null);
        await walk.UntilAsync("draining said", () => panel.State == "draining" && panel.Drainable == "Undrain");
        await panel.ToggleDrainCommand.ExecuteAsync(null);
        await walk.UntilAsync("undrained", () => panel.State == "enabled");
        await panel.ToggleEnabledCommand.ExecuteAsync(null);
        await walk.UntilAsync("disabled, which stops a probe", () => panel.State == "disabled" && !panel.CanProbe);
        await panel.ToggleEnabledCommand.ExecuteAsync(null);
        await walk.UntilAsync("enabled again", () => panel.State == "enabled");

        panel.ServeProject = panel.Serveable[0];
        panel.CodeRoot = "/opt/walked/code";
        panel.WorktreeRoot = "/opt/walked/worktrees";
        panel.RunRoot = "/opt/walked/run";
        await panel.ServeCommand.ExecuteAsync(null);
        await walk.UntilAsync("a project served", () => panel.Projects.Count == 1 && panel.ServeProject is null);

        await panel.ProbeHostCommand.ExecuteAsync(null);
        await walk.UntilAsync("a probe answered", () => panel.Host?.Probe is not null || panel.Error is not null, 60);
        Console.WriteLine($"     probe: {panel.Probe}: {panel.ProbeDetail}; error {panel.Error}");

        await walk.Shell.Connection!.Sdk.EngineTokens.PutEngineTokenAsync(token, new MaroonedSoftware.Wilson.Sdk.Models.PutEngineTokenRequest { Token = "walked-not-a-token" });
        hosts.Name = worker;
        hosts.Kind = "Worker";
        await hosts.RegisterCommand.ExecuteAsync(null);
        await walk.UntilAsync("a worker registered", () => hosts.Hosts.Any(found => found.Name == worker && found.EngineTokens.Contains(token)));
        var workerPanel = hosts.Hosts.First(found => found.Name == worker);
        workerPanel.EngineToken = token;
        await walk.UntilAsync("an engine token assigned", () => workerPanel.Host?.EngineToken == token);
        await walk.UntilAsync("a worker nobody has started reading as not connected", () => workerPanel.NotConnected && workerPanel.ConnectionState == "not connected" && workerPanel.MachineNote is not null);

        using (await Walker.ConnectWorkerAsync(walk.Shell.Connection!.Origin, worker))
        {
            await walk.UntilAsync("the page's own reading finding the connection", () => workerPanel.Connected);
            Console.WriteLine($"     worker: {workerPanel.ConnectionState}; {workerPanel.Summary}");
            await walk.UntilAsync("the daemon's own sampling reaching the page", () => workerPanel.Machine is not null && workerPanel.Disks.Count == 2);
            Console.WriteLine($"     machine: {workerPanel.MachineRead}: {workerPanel.Machine}; {string.Join("; ", workerPanel.Disks.Select(disk => $"{disk.Text} low={disk.Low}"))}");
            walk.Shot("11-hosts-worker-connected");
        }

        await walk.UntilAsync("the page's own reading finding it gone", () => workerPanel.NotConnected && workerPanel.Machine is null && workerPanel.Disks.Count == 0);

        var project = panel.Projects[0].Project;
        Walker.Sql($"insert into wilson.leases (resource_key, project, card_id, acquired_at) values ('host:{name}:slot:0', '{project}', '0001', now() - interval '12 minutes')");
        await hosts.ReadAsync(CancellationToken.None);
        await walk.UntilAsync("a slot in use", () => panel.Running.Count == 1, 5);
        await walk.UntilAsync("no runs yet said so", () => panel.NoRuns, 5);

        // Rows only, as nothing here runs a stage: oldest first, so the card holding the slot is newest.
        foreach (var (card, stage, ending, minutes) in new[]
        {
            ("0003", "testing", "stage.host-lost", 400), ("0002", "review", "stage.interrupted", 300), ("0002", "implementing", "stage.failed", 200),
            ("0003", "implementing", "stage.stale", 150), ("0002", "testing", "stage.passed", 100), ("0003", "review", "stage.passed", 60),
        })
        {
            Walker.Sql($"insert into wilson.card_events (project, card_id, stage, type, payload, created_at) values ('{project}', '{card}', '{stage}', 'stage.placed', '{{\"host\": \"{name}\"}}', now() - interval '{minutes} minutes'), ('{project}', '{card}', '{stage}', '{ending}', '{{}}', now() - interval '{minutes - 12} minutes')");
        }

        Walker.Sql($"insert into wilson.card_events (project, card_id, stage, type, payload, created_at) values ('{project}', '0001', 'implementing', 'stage.placed', '{{\"host\": \"{name}\"}}', now() - interval '12 minutes')");
        await hosts.ReadAsync(CancellationToken.None);
        await walk.UntilAsync("the newest runs, the running one first", () => panel.Runs.Count == 5 && panel.Runs[0] is { Outcome: "running", CardId: "0001" } && panel.MoreRuns);
        walk.Shot("11-hosts");
        panel.ToggleRunsCommand.Execute(null);
        await walk.UntilAsync("every run, once asked", () => panel.Runs.Count == 7 && panel.RunsToggle == "Show fewer");
        Console.WriteLine($"     runs: {string.Join("; ", panel.Runs.Select(run => $"{run.Outcome} {run.Card} {run.Detail}"))}");
        walk.Shot("11-hosts-runs");
        panel.ToggleRunsCommand.Execute(null);
        panel.OpenRunCommand.Execute(panel.Runs[1]);
        await walk.UntilAsync("a run opening its card", () => walk.Shell.Page is CardViewModel { Id: "0003" });
        walk.Shell.Back();
        await walk.UntilAsync("back from the run's card", () => walk.Shell.Page == hosts);

        panel.OpenCardCommand.Execute(panel.Running[0]);
        await walk.UntilAsync("a slot opening its card", () => walk.Shell.Page is CardViewModel { Id: "0001" });
        await walk.UntilAsync("the header still on Hosts", () => walk.Shell.OnHosts);
        walk.Shell.Back();
        await walk.UntilAsync("back on the same page", () => walk.Shell.Page == hosts);
        Walker.Sql($"delete from wilson.leases where resource_key = 'host:{name}:slot:0'");

        await panel.RemoveCommand.ExecuteAsync(null);
        await walk.UntilAsync("removal asking first", () => panel.ConfirmingRemoval);
        walk.Shot("11-hosts-confirm");
        panel.ForgetRemoval();
        await panel.StopServingCommand.ExecuteAsync(panel.Projects[0]);
        await walk.UntilAsync("no longer serving", () => panel.NoProjects);
        await panel.RemoveCommand.ExecuteAsync(null);
        await panel.RemoveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the host gone", () => hosts.Hosts.All(found => found.Name != name));
        await workerPanel.RemoveCommand.ExecuteAsync(null);
        await workerPanel.RemoveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the worker gone", () => hosts.Hosts.All(found => found.Name != worker));
        await walk.Shell.Connection!.Sdk.EngineTokens.RemoveEngineTokenAsync(token);
    }

    /// <summary>The project's history, kept live by the feed, with its link into a card and back.</summary>
    private static async Task ActivityAsync(Walker walk, BoardViewModel board)
    {
        walk.Shell.ShowActivityCommand.Execute(null);
        var activity = walk.Page<ActivityViewModel>();
        await walk.UntilAsync("the project's events, and the feed live", () => activity.Events.Count > 0 && activity.Live);
        Console.WriteLine($"     activity: {activity.Events.Count} events, more: {activity.HasMore}");
        Walker.Emit("0003", "implementing", "card.flagged", """{"reason":"Walked: a new event reaching the page"}""");
        await walk.UntilAsync("a new event arriving from the feed", () => activity.Events[0].Reason?.StartsWith("Walked:", StringComparison.Ordinal) == true);
        walk.Shot("03-activity");
        if (activity.HasMore)
        {
            var before = activity.Events.Count;
            await activity.ShowOlderCommand.ExecuteAsync(null);
            await walk.UntilAsync("older events", () => activity.Events.Count > before);
        }

        activity.OpenCardCommand.Execute(activity.Events[0].CardId);
        await walk.UntilAsync("a row opening its card", () => walk.Shell.Page is CardViewModel { Id: "0003" });
        walk.Shell.Back();
        await walk.UntilAsync("back on activity", () => walk.Shell.Page == activity);
        walk.Shell.Back();
        await walk.UntilAsync("back on the board", () => walk.Shell.Page == board && board.Live);
        await Task.Delay(TimeSpan.FromSeconds(1));
    }

    /// <summary>The header's count, from the page that has no feed, and the board narrowed to it, then nothing flagged.</summary>
    private static async Task FlaggedAsync(Walker walk, BoardViewModel board)
    {
        Walker.Sql("update wilson.cards set needs_human = true, needs_human_reason = 'Walked: read me' where id = '0003'");
        walk.Shell.ShowChatCommand.Execute(null);
        await walk.UntilAsync("the count in the header away from the board", () => walk.Shell.Flagged is not null);
        walk.Shell.ShowFlaggedCommand.Execute(null);
        await walk.UntilAsync("the board narrowed to it", () => walk.Shell.Page == board && board.FlaggedOnly && board.Columns.Count > 0 && board.Columns.All(column => column.Cards.All(tile => tile.Card.NeedsHuman)));
        walk.Shot("03-flagged");

        Walker.Sql("update wilson.cards set needs_human = false, needs_human_reason = null where id = '0003'; update wilson.cards set needs_human = false where needs_human");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("nothing flagged said, and the count gone", () => board.NothingFlagged && walk.Shell.Flagged is null);
        walk.Shot("03-flagged-none");
        board.FlaggedOnly = false;
        await Task.Delay(TimeSpan.FromSeconds(1));
    }

    /// <summary>
    /// A real registration on the throwaway API, onto its own scratch repo: the folder picker, the roots
    /// following the code root, a taken name refused, then a project with a board. Its row goes afterwards.
    /// </summary>
    private static async Task NewProjectAsync(Walker walk, ProjectsViewModel projects, BoardViewModel board)
    {
        var name = $"walked-{DateTime.UtcNow:HHmmss}";
        var root = Walker.Query("select code_root from wilson.projects order by name limit 1");
        projects.NewProjectCommand.Execute(null);
        var form = walk.Page<NewProjectViewModel>();

        await form.BrowseCommand.ExecuteAsync(PathField.CodeRoot);
        await walk.UntilAsync("the folders on the server", () => form.Listing is not null);
        Console.WriteLine($"     browsing {form.Listing!.Path}: {form.Folders.Count} folders");
        walk.Shot("03p-new-project-browse");
        var hidden = form.Folders.Count;
        form.ShowHidden = true;
        await walk.UntilAsync("hidden folders shown", () => form.Folders.Count >= hidden);
        form.ShowHidden = false;
        await form.UpCommand.ExecuteAsync(null);
        form.CancelPickCommand.Execute(null);

        form.CodeRoot = $"{root}/does/not/exist";
        await form.BrowseCommand.ExecuteAsync(PathField.CodeRoot);
        await walk.UntilAsync("a missing folder opening its nearest parent", () => form.Listing?.Path == root || form.PickError is not null);
        Console.WriteLine($"     nearest: {form.Listing?.Path}, {form.PickError}");
        if (form.PickError is null)
        {
            form.SelectFolderCommand.Execute(null);
        }
        else
        {
            form.CancelPickCommand.Execute(null);
            form.CodeRoot = root;
            form.Name = "walked";
        }

        await walk.UntilAsync("the name taken from the folder", () => form.CodeRoot == root && !string.IsNullOrEmpty(form.Name));
        await walk.UntilAsync("the roots following it", () => form.ShownWorktreeRoot.EndsWith($"/.worktrees/{form.Name}", StringComparison.Ordinal));
        walk.Shot("03q-new-project");

        form.Name = Walker.Query("select name from wilson.projects order by name limit 1");
        await form.CreateCommand.ExecuteAsync(null);
        await walk.UntilAsync("a taken name refused", () => form.Failure is not null);
        Console.WriteLine($"     {form.FailureTitle}: {form.Failure}");
        walk.Shot("03r-new-project-refused");

        form.Name = name;
        await form.CreateCommand.ExecuteAsync(null);
        await walk.UntilAsync("the new project's board", () => walk.Shell.Page == board && board.Project == name);
        await walk.UntilAsync("its columns", () => board.Columns.Count > 0);
        walk.Shot("03s-new-project-board");
        board.Project = board.Projects[0];
        await walk.UntilAsync("the first project again", () => board.Columns.Count > 0 && board.Project != name);
        Walker.Sql($"delete from wilson.lane_revisions where project = '{name}'; delete from wilson.lanes where project = '{name}'; delete from wilson.project_lane_settings where project = '{name}'; delete from wilson.stage_configs where project = '{name}'; delete from wilson.projects where name = '{name}'");
    }

    /// <summary>The projects page, through a real press on a project, back to the board that holds it.</summary>
    private static async Task ProjectsAsync(Walker walk, BoardViewModel board)
    {
        walk.Shell.ShowProjectsCommand.Execute(null);
        var projects = walk.Page<ProjectsViewModel>();
        await walk.UntilAsync("the projects listed, under Projects", () => projects.Projects.Count > 0 && walk.Shell.OnProjects);
        walk.Shot("03-projects");
        await NewProjectAsync(walk, projects, board);
        walk.Shell.ShowProjectsCommand.Execute(null);
        await walk.UntilAsync("back on the projects", () => walk.Shell.Page == projects);
        await Task.Delay(TimeSpan.FromMilliseconds(500));
        walk.Click(walk.Center(projects.Projects[0]));
        await walk.UntilAsync("a project opening its board", () => walk.Shell.Page == board && board.Project == projects.Projects[0]);
        await walk.UntilAsync("that board live", () => board.Live);
        await Task.Delay(TimeSpan.FromSeconds(1));
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

    /// <summary>A ready card of the walk's own, on a real branch, sent back with a comment on a line.</summary>
    private static async Task FindingsAsync(Walker walk, BoardViewModel board)
    {
        // The seeded config stops at implementing, and only a ready card takes findings. One lane, taken back below.
        Walker.Sql("insert into wilson.lanes (project, name, position, mode, worktree, on_pass, on_fail, instructions) select project, 'ready', 99, 'manual', 'none', 'merged', 'implementing', 'Wait for the operator.' from wilson.project_lane_settings; insert into wilson.lane_revisions (project, lane, message) select project, 'ready', 'walk' from wilson.project_lane_settings");
        Walker.ScratchBranch("walk-diff");
        Walker.Sql("delete from wilson.card_versions where card_id = '9996'; delete from wilson.cards where id = '9996'");
        Walker.Sql("insert into wilson.cards (project, id, title, stage, body, branch) select project, '9996', 'Walked ready', 'ready', '', 'walk-diff' from wilson.cards limit 1");
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the ready card", () => board.Columns.Any(column => column.Cards.Any(tile => tile.Card.Id == "9996")));
        board.OpenCard(board.Columns.SelectMany(column => column.Cards).First(tile => tile.Card.Id == "9996").Card);
        var card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the card", () => card.Card is not null);
        card.SelectedTab = 2;
        await walk.UntilAsync("the diff", () => card.DiffRows.Any(row => row.NewNumber is not null));
        Console.WriteLine($"     diff: {card.DiffNote}");

        card.SelectedRow = card.DiffRows.First(row => row.IsHunk);
        await walk.UntilAsync("no composer on a line with no number", () => !card.Composing);

        card.SelectedRow = card.DiffRows.First(row => row.NewNumber == 2);
        await walk.UntilAsync("a composer on the line", () => card.Composing && card.ComposingOn == "walk.txt:2");
        walk.Shot("03c-diff-composing");
        card.Problem = "This line is wrong.";
        await walk.UntilAsync("half a comment not being enough", () => !card.AddFindingCommand.CanExecute(null));
        card.Suggestion = "Say two better.";
        card.AddFindingCommand.Execute(null);
        card.SelectedRow = card.DiffRows.First(row => row.NewNumber == 3);
        card.Concern = true;
        card.Problem = "A lesser worry.";
        card.Suggestion = "Think again.";
        card.AddFindingCommand.Execute(null);
        await walk.UntilAsync("two comments pending", () => card.Findings.Count == 2 && !card.Composing);
        walk.Shot("03d-diff-pending");
        card.RemoveFindingCommand.Execute(card.Findings[1]);
        await card.SubmitFindingsCommand.ExecuteAsync(null);
        await walk.UntilAsync("the comment sent, and the card sent back", () => card.Findings.Count == 0 && card.Card?.Stage != "ready");
        Console.WriteLine($"     findings: {card.Notice}, now {card.Card!.Stage}");
        walk.Shot("03e-diff-sent");
        walk.Shell.Back();
        await walk.UntilAsync("back on the board", () => walk.Shell.Page == board);
        Walker.Sql("delete from wilson.card_versions where card_id = '9996'; delete from wilson.cards where id = '9996'; delete from wilson.lanes where name = 'ready'; insert into wilson.lane_revisions (project, lane, message) select project, 'ready', 'walk' from wilson.project_lane_settings");
        await board.RefreshCommand.ExecuteAsync(null);
    }

    private static async Task CardsAsync(Walker walk, BoardViewModel board)
    {
        var title = $"Walked {DateTime.UtcNow:HHmmss}";
        board.NewCard();
        var form = walk.Page<CardFormViewModel>();
        await form.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("a card with no title refused", () => form.Error is not null);

        form.Title = title;
        form.Body = "## Goal\n\nMade by the desktop walk, after [[0001]].\n\n- One **bold** item\n- Another with `code`\n\nA second paragraph, long enough to wrap and to show how a card's body reads at the width of a window rather than on a phone.\n\n## Files in scope\n\n- `apps/desktop/**`\n\n## Acceptance criteria\n\n- AC1: The walk reaches here\n- AC2: Something a review found wanting";
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
        await HistoryAsync(walk, card);
        await LinksAsync(walk, card);

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

        // That press must not outlive the page, or the board stops drawing with no sign of it.
        board.Filter = "matches no card";
        await walk.UntilAsync("the board drawing after a click opened a card", () => board.Columns.All(column => column.Cards.Count == 0));
        board.Filter = null;
        await walk.UntilAsync("the card back in its column", () => board.Columns.Any(column => column.Cards.Count > 0));

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
        var over = walk.Center(Column("implementing"));
        walk.Down(picked);
        walk.MoveTo(picked + new Point(20, 0));
        walk.MoveTo(over);
        await walk.UntilAsync("a card held over a column", () => Tile().Dragged && Column("implementing").Target);
        walk.Press(Key.Escape, PhysicalKey.Escape);
        await walk.UntilAsync("Escape putting it back", () => !Tile().Dragged && !Column("implementing").Target);
        walk.Up(over);
        await board.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the cancelled drag asking for nothing", () => Tile().Card.Stage == stage && walk.Shell.Page == board);

        // Connecting replays every card and re-reads the board, which would drop the row below before the press.
        await Task.Delay(TimeSpan.FromSeconds(1));

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
        board.ToggleCollapsedCommand.Execute(Column("done"));
        await walk.UntilAsync("columns folded and remembered", () => walk.Settings().Collapsed[board.Project!].Contains("done"));
        walk.Shot("04b-board-collapsed");
        walk.Drag(walk.Center(across), walk.Center(Column("implementing")), "04c-board-dragging");
        await walk.UntilAsync("the drop moving the card", () => board.Columns.First(column => column.Name == "implementing").Cards.Any(tile => tile.Card.Id == "9999"));
        walk.Shot("04d-board-dropped");
        await walk.UntilAsync("a redraw keeping them folded", () => Column("done").Collapsed);
        board.ToggleCollapsedCommand.Execute(Column("implementing"));
        board.ToggleCollapsedCommand.Execute(Column("done"));
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
        walk.Shot("05-card-no-tools");
        await walk.UntilAsync("the card live", () => card.Live);
        Walker.Emit(card.Id, card.Card!.Stage, "tool.executed", """{"tool":"bash","command":"pnpm test --filter @wilson/api"}""");
        Walker.Emit(card.Id, card.Card.Stage, "tool.denied", """{"tool":"write","reason":"outside the files in scope","path":"secrets.env"}""");
        Walker.Emit(card.Id, card.Card.Stage, "tool.executed", """{"tool":"Edit","path":"apps/desktop/CLAUDE.md"}""");
        await walk.UntilAsync("the tool calls arriving", () => card.Tools.Count == 3);
        walk.Shot("05-card-tools");
    }

    /// <summary>A placed run with a review's result, written to the throwaway database as a stage would.</summary>
    private static async Task HistoryAsync(Walker walk, CardViewModel card)
    {
        var (id, stage) = (card.Id, card.Card!.Stage);
        Walker.Emit(id, stage, "stage.placed", """{"host":"my-mac"}""");
        Walker.Emit(id, "review", "stage.dispatched", "{}");
        Walker.Emit(id, "review", "tool.executed", """{"tool":"read","path":"a.ts"}""");
        Walker.Emit(id, "review", "stage.failed", """{"result":{"criteria":[{"id":"AC1","status":"met"},{"id":"AC2","status":"unmet"}]},"usage":{"inputTokens":1200,"cachedInputTokens":300,"outputTokens":450},"trace":{"reads":2,"readPaths":["a.ts","b.ts"],"finalMessage":"One criterion is not met."},"failures":["AC2 is unmet"]}""");
        await card.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the review on its criteria", () => card.Criteria.Any(criterion => criterion.Status == "unmet"));
        await walk.UntilAsync("the files in scope", () => card.Scope.Count == 1);
        await walk.UntilAsync("the run placed, and tallied", () => card.RanOn == "ran on my-mac" && card.Attempts.Any(attempt => attempt.Outcome == "failed"));
        await walk.UntilAsync("the usage table", () => card.UsageRows.Any(row => row.Total));
        await walk.UntilAsync("a version", () => card.Versions.Count > 0);
        walk.Shot("05a-card-plan");
        card.SelectedTab = 1;
        walk.Shot("05b-card-activity");
        card.SelectedTab = 0;
    }

    /// <summary>A dependency for real, a refused address, and a snapshot written by hand, as fetching one needs the internet.</summary>
    private static async Task LinksAsync(Walker walk, CardViewModel card)
    {
        card.SelectedTab = 3;
        walk.Shot("05c-card-context-empty");

        card.NewDependency = "0001";
        await card.AddDependencyCommand.ExecuteAsync(null);
        await walk.UntilAsync("the dependency listed, and the box cleared", () => card.Dependencies.Count == 1 && card.NewDependency is null);
        card.NewDependency = "9000";
        await card.AddDependencyCommand.ExecuteAsync(null);
        await walk.UntilAsync("a card that is not there refused, and kept in the box", () => card.Notice is not "Depends on 9000." && card.NewDependency == "9000");
        Console.WriteLine($"     dependency: {card.Notice}");
        card.NewDependency = null;

        card.ContextUrl = "http://localhost:13150/api/health";
        await card.AttachContextCommand.ExecuteAsync(null);
        await walk.UntilAsync("a private address refused, and kept in the box", () => card.Notice is not "Context attached." && card.Notice is not null && card.ContextUrl is not null);
        Console.WriteLine($"     attach: {card.Notice}");
        card.ContextUrl = null;

        Walker.Sql($"insert into wilson.card_context (project, card_id, source_url, fetched_at, fetched_by, title, content, content_hash) select project, id, 'https://example.com/spec', now(), 'operator@example.com', 'The spec', 'Words', 'hash' from wilson.cards where id = '{card.Id}'");
        await card.RefreshCommand.ExecuteAsync(null);
        await walk.UntilAsync("the snapshot listed", () => card.Context.Count == 1);
        walk.Shot("05d-card-context");

        card.AskRemoveContextCommand.Execute(card.Context[0]);
        walk.Shot("05e-card-context-remove");
        await card.ConfirmCommand.ExecuteAsync(null);
        await walk.UntilAsync("the snapshot removed", () => card.Context.Count == 0);
        await card.RemoveDependencyCommand.ExecuteAsync(card.Dependencies[0]);
        await walk.UntilAsync("the dependency removed", () => card.Dependencies.Count == 0);
        card.SelectedTab = 0;
    }

    /// <summary>A card of its own, in planning, and nothing else: `plan` as a sixth argument walks only this.</summary>
    private static async Task PlanOnlyAsync(Walker walk)
    {
        walk.Shell.ShowBoardCommand.Execute(null);
        var board = walk.Page<BoardViewModel>();
        await walk.UntilAsync("columns", () => board.Columns.Count > 0);

        var title = $"Walked {DateTime.UtcNow:HHmmss}";
        board.NewCard();
        var form = walk.Page<CardFormViewModel>();
        form.Title = title;
        form.Body = "## Goal\n\nMade by the desktop walk to plan.";
        await form.SaveCommand.ExecuteAsync(null);
        await walk.UntilAsync("the new card on the board", () => walk.Shell.Page == board && board.Columns.Any(column => column.Cards.Any(tile => tile.Card.Title == title)));

        board.OpenCard(board.Columns.SelectMany(column => column.Cards).Select(tile => tile.Card).First(card => card.Title == title));
        var card = walk.Page<CardViewModel>();
        await walk.UntilAsync("the stages to move to", () => card.Card is not null && card.Stages.Count > 0);
        if (!card.CanPlan)
        {
            card.MoveTo = "planning";
            await card.MoveCommand.ExecuteAsync(null);
        }

        await PlanningAsync(walk, card);
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

        plan.Draft = "# Plan\n\nDo the first thing, and **then** the second thing.\n\nDo the first thing again.";
        await walk.UntilAsync("the edit said to be unsaved", () => plan.Unsaved && plan.CanApprove);
        plan.AskApproveCommand.Execute(null);
        walk.Shot("10a-plan-approve");
        await plan.SaveDraftCommand.ExecuteAsync(null);
        await walk.UntilAsync("the draft refused on the dialog, and kept", () => plan.ApproveError is not null && plan.Draft!.StartsWith("# Plan", StringComparison.Ordinal));
        Console.WriteLine($"     save: {plan.ApproveError}");
        walk.Shot("10b-plan-approve-refused");
        plan.CancelApproveCommand.Execute(null);

        plan.Preview = true;
        await walk.UntilAsync("the edit surviving the poll", () => plan.Draft!.Contains("**then**", StringComparison.Ordinal));
        walk.Select("then the");
        await walk.UntilAsync("a real selection in the preview", () => plan.Quote == "then the" && plan.Composing);
        walk.Shot("10-plan-composing");
        // Into the box itself and off with Enter, which shows the card took the focus.
        walk.Type("Which second thing?");
        await walk.UntilAsync("the comment typed into the card", () => plan.CommentText == "Which second thing?");
        walk.Press(Key.Enter, PhysicalKey.Enter);
        await walk.UntilAsync("the comment added, and anchored", () => plan.Comments.Count == 1 && plan.Marks is { Count: 1 });
        walk.Shot("10-plan-commented");
        await walk.UntilAsync("feedback held back by the unsaved edit", () => plan.FeedbackBlocked is not null && !plan.CanSendFeedback);
        plan.ShowCommentCommand.Execute(plan.Comments[0]);
        await walk.UntilAsync("the comment open beside its passage", () => plan.Viewing && plan.CardAnchor is not null && plan.Comments[0].Active);
        walk.Shot("10d-plan-comment-open");
        plan.CloseCommentCommand.Execute(null);
        await walk.UntilAsync("the card put away", () => !plan.Viewing);
        walk.ClickText("then");
        await walk.UntilAsync("a press on the highlight opening its comment", () => plan.Viewing);
        walk.ClickText("second");
        await walk.UntilAsync("a press beside it putting the card away", () => !plan.Viewing);

        plan.Draft = "# Plan\n\nDo the only thing.";
        plan.Preview = false;
        plan.Preview = true;
        await walk.UntilAsync("the comment listed as outdated", () => plan.Outdated.Count == 1 && plan.Comments.Count == 0);
        walk.Shot("10c-plan-outdated");
        await plan.ResolveCommentCommand.ExecuteAsync(plan.Outdated[0]);
        await walk.UntilAsync("the comment resolved", () => plan.Outdated[0].Resolved);
        await plan.ReopenCommentCommand.ExecuteAsync(plan.Outdated[0]);
        await walk.UntilAsync("the comment reopened", () => !plan.Outdated[0].Resolved);
        await plan.ResolveCommentCommand.ExecuteAsync(plan.Outdated[0]);
        await walk.UntilAsync("the comment resolved again", () => plan.Outdated[0].Resolved);

        plan.UseIncomingCommand.Execute(null);
        await walk.UntilAsync("the edit discarded", () => !plan.Unsaved);
        var rendered = ChatMarkdown.RenderedText(plan.Draft ?? string.Empty);
        var passage = rendered.Length < 12 ? rendered : rendered[..12];
        plan.SelectPassage(0, passage.Length, passage);
        plan.CommentText = "Say this more plainly.";
        await plan.AddCommentCommand.ExecuteAsync(null);
        await walk.UntilAsync("feedback ready to send", () => plan.CanSendFeedback);
        walk.Shot("10e-plan-feedback-ready");
        await plan.SendFeedbackCommand.ExecuteAsync(null);
        await walk.UntilAsync("the feedback turn answered, or the refusal said", () => plan.Idle, 300);
        Console.WriteLine($"     feedback: open comments {plan.OpenComments}, lines {plan.Lines.Count}, error: {plan.Error}");
        walk.Shot("10f-plan-feedback-sent");
        plan.Preview = false;

        plan.Composer = "Reply with the single word: ok";
        await plan.SendCommand.ExecuteAsync(null);
        await walk.UntilAsync("the turn answered, or the refusal said", () => plan.Idle, 120);
        Console.WriteLine($"     turn: lines {plan.Lines.Count}, error: {plan.Error}");
        walk.Shot("11-plan-turn");

        await plan.CloseSessionCommand.ExecuteAsync(null);
        await walk.UntilAsync("back on the card", () => walk.Shell.Page == card);
    }

    /// <summary>A real image through a real turn: refused, scaled, shown in the box, sent, answered and drawn from the API.</summary>
    /// <summary>Proposals read back from the API, so the arguments arrive as stored: nothing makes the agent propose on cue.</summary>
    private static async Task ChatActionsAsync(Walker walk, ThreadsViewModel home)
    {
        const string CardBody = """{"body":{"title":"Stage agents: read public GitHub repos (per-stage web access, github tier)","stage":"parking-lot","body":"## Goal\n\nLet a stage agent read files from **public** GitHub repositories, and nothing else on the network.\n\n## Constraints\n\n1. The guard stays the only source of permission.\n2. The default is `none`.\n3. See [the docs](https://example.com/docs).\n\n## Tasks\n\n- Add the setting.\n- Add the tool.\n- Gate it in the guard.\n- Tell the stage agent.\n\n## Acceptance criteria\n\n- AC1: refused with no setting.\n- AC2: fetches at the github level.\n- AC3: other hosts refused.\n- AC4: a redirect off the list refused.\n- AC5: the size cap holds.\n- AC6: no request carries a token.\n- AC7: every call is recorded."}}""";
        var thread = await walk.Shell.Connection!.Sdk.Chat.StartAChatThreadAsync();
        var propose = (string operation, string arguments, string summary) => Walker.Sql(
            $"insert into wilson.chat_pending_actions (thread_id, project, operation, arguments, summary, expires_at) values ({thread.Id}, 'wilson', '{operation}', $json${arguments}$json$::jsonb, '{summary}', now() + interval '10 minutes')");
        propose("create_card", CardBody, "Create a parking-lot card for reading public GitHub repos");
        propose("move_card", """{"id":"0003","body":{"stage":"review"}}""", "Move 0003 to review");
        propose("set_labels", """{"id":"0004","body":{"labels":["agents","web"],"reason":null}}""", "Label 0004");

        await home.AnsweredAsync();
        await walk.UntilAsync("the proposed chat listed", () => home.Threads.Any(row => row.Id == thread.Id));
        home.Open(home.Threads.First(row => row.Id == thread.Id));
        var chat = home.Chat!;
        await walk.UntilAsync("the proposals read back", () => chat.Entries.OfType<ActionRow>().Count() == 3);
        var card = chat.Entries.OfType<ActionRow>().First();
        Console.WriteLine($"     fields: {string.Join(", ", card.Fields.Select(field => $"{field.Label}={field.Kind}"))}");
        walk.ScrollTo("Create a parking-lot card for reading public GitHub repos");
        walk.Shot("14c-actions-fields");
        walk.Click(walk.CenterOf("RawArguments"));
        walk.Shot("14d-actions-raw");
        walk.Click(walk.CenterOf("RawArguments"));

        await home.ArchiveCommand.ExecuteAsync(home.Threads.First(row => row.Id == thread.Id));
    }

    /// <summary>A proposal drawn from arguments as the API sends them.</summary>
    private static ActionRow Posed(string id, string summary, string detail, string arguments, string status, bool awaiting, bool failed, string? error)
    {
        var parsed = JsonDocument.Parse(arguments).RootElement;
        return new ActionRow(id, summary, detail, ChatArguments.Fields(parsed), ChatArguments.Pretty(parsed), status, awaiting, failed, error);
    }

    private static async Task ChatImagesAsync(Walker walk, ThreadsViewModel home)
    {
        home.NewChat();
        var chat = home.Chat!;
        await walk.UntilAsync("the greeting", () => chat.Empty);

        chat.AddImage("note.heic", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
        await walk.UntilAsync("a HEIC refused in words", () => chat.Error?.Contains("not a PNG", StringComparison.Ordinal) == true && !chat.HasPending);

        chat.AddImage("big.png", SolidPng(3000, 1800, 0xFF, 0x00, 0x00));
        await walk.UntilAsync("the large image in the box", () => chat.Pending.Count == 1);
        var pending = chat.Pending[0];
        await walk.UntilAsync("it scaled to the longest edge a model takes", () => pending.Picture.PixelSize.Width == ChatImages.MaxEdge && chat.Error is null);
        await walk.UntilAsync("an image alone being enough to send", () => chat.CanSend);
        chat.AddImage("second.png", SolidPng(320, 200, 0x00, 0x00, 0xFF));
        await walk.UntilAsync("the second image in the box", () => chat.Pending.Count == 2);
        walk.Shot("13b-chat-images-in-box");
        chat.RemoveImageCommand.Execute(chat.Pending[1]);
        await walk.UntilAsync("the second image removed", () => chat.Pending.Count == 1);

        var clipboard = walk.Clipboard;
        await clipboard.SetTextAsync("pasted words");
        walk.Chord(PhysicalKey.V, RawInputModifiers.Meta);
        await walk.UntilAsync("Cmd+V pasting text as text", () => chat.Composer == "pasted words" && chat.Pending.Count == 1);
        chat.Composer = null;
        using (var picture = new Bitmap(new MemoryStream(SolidPng(200, 120, 0x00, 0xFF, 0x00))))
        {
            await clipboard.SetBitmapAsync(picture);
            walk.Chord(PhysicalKey.V, RawInputModifiers.Meta);
            await walk.UntilAsync("Cmd+V pasting a picture as an image", () => chat.Pending.Count == 2 && string.IsNullOrEmpty(chat.Composer));
        }

        chat.RemoveImageCommand.Execute(chat.Pending[1]);
        chat.Composer = "What colour is this image? Answer in one word.";
        chat.SendCommand.Execute(null);
        await walk.UntilAsync("the box empty as it goes", () => !chat.HasPending && chat.Sending);
        walk.Shot("13c-chat-image-sending");
        await walk.UntilAsync("the chat answered, or the refusal said", () => chat.Idle, 120);
        Console.WriteLine($"     chat images: answer '{chat.Entries.OfType<AnswerEntry>().LastOrDefault()?.Text}', error: {chat.Error}");
        await walk.UntilAsync(
            "the image drawn from the API",
            () => chat.Entries.OfType<UserEntry>().LastOrDefault()?.Images is [{ Picture: not null }]);
        walk.Shot("13d-chat-image-sent");

        var seen = chat.Id;
        chat.Composer = "What colour was the image I just sent? Answer in one word.";
        chat.SendCommand.Execute(null);
        await walk.UntilAsync("a follow-up going", () => chat.Sending);
        await walk.UntilAsync("a follow-up answered", () => chat.Idle, 120);
        var remembered = chat.Entries.OfType<AnswerEntry>().Last().Text;
        Console.WriteLine($"     chat images: follow-up answer '{remembered}', error: {chat.Error}");
        await walk.UntilAsync("the next turn still knowing the image", () => remembered.Contains("red", StringComparison.OrdinalIgnoreCase));

        home.NewChat();
        await home.AnsweredAsync();
        home.Open(home.Threads.First(thread => thread.Id == seen));
        var reopened = home.Chat!;
        await walk.UntilAsync(
            "the image still there on reopening the thread",
            () => reopened.Id == seen && reopened.Entries.OfType<UserEntry>().FirstOrDefault()?.Images is [{ Picture: not null }]);

        home.NewChat();
        var alone = home.Chat!;
        alone.AddImage("alone.png", SolidPng(200, 120, 0x00, 0x00, 0xFF));
        alone.SendCommand.Execute(null);
        await walk.UntilAsync("an image alone going", () => alone.Sending);
        await walk.UntilAsync("an image alone answered", () => alone.Idle, 120);
        await walk.UntilAsync(
            "an image alone, drawn with no empty bubble",
            () => alone.Error is null && alone.Entries.OfType<UserEntry>().FirstOrDefault() is { HasText: false, Images: [{ Picture: not null }] });
        await walk.UntilAsync("that chat named for it", () => home.Threads.Any(thread => thread.Current && thread.Title == "Image"));
        walk.Shot("13e-chat-image-alone");

        // The thread going out from under it is a real refusal at the first upload, without needing a broken server.
        Walker.Query($"delete from wilson.chat_threads where id = {alone.Id}");
        alone.Composer = "This will not arrive.";
        alone.AddImage("retry.png", SolidPng(200, 120, 0xFF, 0xFF, 0x00));
        alone.SendCommand.Execute(null);
        await walk.UntilAsync("a failed send going", () => alone.Sending);
        await walk.UntilAsync(
            "a failed send putting the words and the image back",
            () => alone.Idle && alone.Composer == "This will not arrive." && alone.Pending.Count == 1 && alone.Error is not null);
        Console.WriteLine($"     chat images: failed send said '{alone.Error}'");
    }

    /// <summary>A PNG of one colour, written the way a picture from the clipboard is.</summary>
    private static byte[] SolidPng(int width, int height, byte red, byte green, byte blue)
    {
        using var picture = new WriteableBitmap(new PixelSize(width, height), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Opaque);
        using (var locked = picture.Lock())
        {
            var row = new byte[width * 4];
            for (var x = 0; x < width; x++)
            {
                row[x * 4] = blue;
                row[(x * 4) + 1] = green;
                row[(x * 4) + 2] = red;
                row[(x * 4) + 3] = 0xFF;
            }

            for (var y = 0; y < height; y++)
            {
                Marshal.Copy(row, 0, locked.Address + (y * locked.RowBytes), row.Length);
            }
        }

        return PendingImage.PngOf(picture);
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

        walk.Type("second");
        walk.Chord(PhysicalKey.A, RawInputModifiers.Control);
        walk.Type("first ");
        await walk.UntilAsync("Ctrl+A going to the start of the line", () => chat.Composer == "first second");
        walk.Chord(PhysicalKey.E, RawInputModifiers.Control);
        walk.Chord(PhysicalKey.H, RawInputModifiers.Control);
        await walk.UntilAsync("Ctrl+E and Ctrl+H taking the last letter", () => chat.Composer == "first secon");
        walk.Chord(PhysicalKey.A, RawInputModifiers.Control);
        walk.Chord(PhysicalKey.K, RawInputModifiers.Control);
        await walk.UntilAsync("Ctrl+K clearing the line", () => string.IsNullOrEmpty(chat.Composer));
        walk.Type("all of this");
        walk.Chord(PhysicalKey.Backspace, RawInputModifiers.Meta);
        await walk.UntilAsync("Cmd+Backspace clearing the line", () => string.IsNullOrEmpty(chat.Composer));
        walk.Type("one two three");
        walk.Chord(PhysicalKey.A, RawInputModifiers.Control | RawInputModifiers.Shift);
        walk.Type("first");
        await walk.UntilAsync("Ctrl+Shift+A selecting to the start of the line", () => chat.Composer == "first");
        walk.Chord(PhysicalKey.A, RawInputModifiers.Control);
        walk.Chord(PhysicalKey.E, RawInputModifiers.Control | RawInputModifiers.Shift);
        walk.Type("second");
        await walk.UntilAsync("Ctrl+Shift+E selecting to the end of the line", () => chat.Composer == "second");
        walk.Chord(PhysicalKey.A, RawInputModifiers.Control);
        walk.Chord(PhysicalKey.K, RawInputModifiers.Control);
        Console.WriteLine("     composer: macOS text keys passed");

        walk.Type("Reply with the single word: ok");
        await walk.UntilAsync("typing in the box", () => chat.CanSend);
        walk.Press(Key.Enter, PhysicalKey.Enter);
        await walk.UntilAsync("Enter sending it", () => chat.Sending);
        walk.Shot("13a-chat-working");
        await walk.UntilAsync("the chat answered, or the refusal said", () => chat.Idle, 120);
        Console.WriteLine($"     chat: entries {chat.Entries.Count}, error: {chat.Error}");
        await walk.UntilAsync("the chat named in the rail", () => home.Threads.Any(thread => thread.Current && thread.Title != "New chat"));
        walk.Shot("13-chat");
        await ChatImagesAsync(walk, home);

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
        chat.Entries.Add(Posed("posed", "Move 0003 to review", "Runs move_card in wilson as you. Expires in 10 minutes.", """{"id":"0003","body":{"stage":"review"}}""", "pending", true, false, null));
        chat.Entries.Add(Posed("posed-2", "Merge 0002", "Runs merge_card in wilson as you.", """{"id":"0002"}""", "failed", false, true, "cannot merge 0002: it is in \"planning\", not \"ready\""));
        chat.Entries.Add(Posed("posed-3", "Create a parking-lot card", "Runs create_card in wilson as you. Expires in 9 minutes.", """{"body":{"body":"## Goal\n\nLet a stage agent read **public** GitHub repositories, and nothing else.\n\n## Constraints\n\n1. The guard stays the only source of permission.\n2. The default is `none`.\n3. See [the docs](https://example.com/docs).\n\n## Tasks\n\n- Add the setting.\n- Add the tool.\n- Gate it in the guard.\n- Tell the stage agent.\n\n## Acceptance criteria\n\n- AC1: refused with no setting.\n- AC2: fetches at the github level.\n- AC3: other hosts refused.\n- AC4: a redirect off the list refused.\n- AC5: the size cap holds.","stage":"parking-lot","title":"Stage agents: read public GitHub repos","labels":["agents","web"],"webAccess":null}}""", "pending", true, false, null));
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
