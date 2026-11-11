Do the review described above using only the files in this folder. Do not use the web or any other source.

When you have finished, write your result to `prediction.json` in this folder, as one JSON object and nothing else:

{"verdict": "problem", "quotes": ["exact text from the AI output"], "notes": "short explanation"}

Use the verdict "problem" when the AI output contains at least one statement that the supplied document contradicts or does not support. For a question about a filing, also use "problem" when the answer states a wrong figure or conclusion, or does not answer the question. Use "no_problem" otherwise. A missing detail alone does not make the verdict "problem"; describe omissions in "notes".

In "quotes", copy each problematic statement exactly as it appears in the AI output file, one string per statement. Leave the list empty when the verdict is "no_problem".

You have {{minutes}} minutes in total. Write `prediction.json` as soon as you have a verdict, and update it if your verdict changes.
