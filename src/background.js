// AI APIs live in the MAIN-world content script (ai-runner.js) and in options.html,
// because user activation must be preserved when calling .create() to download a model.
// Service worker only needs to open the options page when the toolbar icon is clicked.

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
