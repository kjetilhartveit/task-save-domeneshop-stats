# Information

You are a skillful programmer who is great at parsing HTML files and also at fetching data from websites.

Your main task is to read a webpage containing many URLs under various domains. You should create a program that will fetch the websites under each URL and in a proper folder (matching the domain name). The saved pages should be fully fetched and static, which means we must also fetch resources like styling and JavaScript - wahtever is necessary to host the files statically.

The file you will parse for URLs is [Webpage statistics.html](Webpage statistics.html). If you view the file in the browser it shows a log-in form, but ignore that.

What is essential though is that the pages might need authentication to be read/fetched. I'm not sure how we'll deal with that yet, but let's figure it out as we go.

# Plan

- [x] Go over the plan and see if there's anything we can improve or is missing. Ask questions in [QA.md](QA.md) if you need clarification.
- [x] Create a program that will fetch the websites under each URL and in a proper folder (matching the domain name). The saved pages should be fully fetched and static, which means we must also fetch resources like styling and JavaScript - wahtever is necessary to host the files statically.
- [x] Run the program and make sure we fetch all we want and that everything is saved to disk. Make sure that we can view the pages in a browser and that they render succesfully and aren't missing information.
  - [x] If authentication is needed, then figure out how to handle it. If you can't then feel free to ask for my input.
  - [x] Feel free look at a page or two to see how the data is structured and re-check that your script works as expected, before running the program on all pages.
- [x] The subpages under each url (domain / month) should also be fetched and saved to disk. E.g. for the url https://stat.domeneshop.no/data/budget.kjetil-hartveit.com/202601/awstats.budget.kjetil-hartveit.com.html we should also fetch from subpages like https://stat.domeneshop.no/data/budget.kjetil-hartveit.com/202601/awstats.budget.kjetil-hartveit.com.urldetail.html, https://stat.domeneshop.no/data/budget.kjetil-hartveit.com/202601/awstats.budget.kjetil-hartveit.com.unknownos.html and https://stat.domeneshop.no/data/budget.kjetil-hartveit.com/202601/awstats.budget.kjetil-hartveit.com.errors404.html (not limited to these examples).
  - [x] We should store necessary media, styling, JavaScript files and more for subpages and everything needed to host the subpages statically.
  - [x] Revise the program to accomodate for the desired changes.
  - [x] Run the program and make sure we fetch all we want and that everything is saved to disk. Make sure that we can view the pages in a browser and that they render succesfully and aren't missing information.
  - Note that we have already fetched the main pages and resources, so we don't need to fetch them again. We should continue with fetching the subpages and their resources.
  - Note: we do not want to fetch from http://www.awstats.org/ as it is not a part of the Domeneshop statistics.
- [x] Fetch the overview page at https://stat.domeneshop.no/ which contains all the domains and links to months. The month links should link to our already fetched pages under each domain. Make sure the overview page is fully static. Make it available for viewing in a browser in the root of the output folder (index.html).

## Execution of plan

- You should git commit and push regularly, particularly after making many code changes.
- After every step you should tick the step off the plan and make sure everything is committed and pushed.
- Be autonomous, but if you need my input then ask for it in [QA.md](QA.md).

# AI-generated commit messages

When generating a commit message then follow these rules:

- follow the rules for conventional commits.
  - `fix` for changes in behavior
  - `refactor` when having rewritten code and does not change behavior.
  - `docs` when only documentation has changed.
  - `chore` for other things not affecting behavior in the application.
  - when updating dependencies then use `fix(deps)` for changes in production dependencies (`dependencies` in [package.json](package.json)) and use `chore(deps)` for changes in development dependencies (`devDependencies` in [package.json](package.json)).
- keep the commit message short and concise
- follow the pattern from existing commit messages.
