'use strict';

var Promise = require('native-promise-only');
var LRU = require('lru-cache');

var Github = require('./github');
var Action = require('./models/action');
var Config = require('./models/config');
var getReviewers = require('./get-reviewers');

var cache = LRU({ max: 100, maxAge: 1000 * 60 });
var cacheEnabled = ['undefined', ''].indexOf(String(process.env.PULL_REVIEW_DISABLE_CACHE)) !== -1;

function getPullReviewConfig(github, pullRequest, pullReviewConfigPath) {
  var key = [pullRequest.owner, pullRequest.repo, pullReviewConfigPath].join('-');
  return Promise.resolve(cache.get(key))
    .then(function (cachedValue) {
      if (cachedValue !== undefined && cacheEnabled) {
        return cachedValue;
      }
      return github.getRepoFile(pullRequest, pullReviewConfigPath, 'utf8');
    })
    .then(function (fetchedValue) {
      cache.set(key, fetchedValue, 1000 * 60 * 3);
      return fetchedValue;
    })
    .catch(function () {
      return null;
    });
}

function getBlameForFile(github, pullRequest, pullRequestRecord) {
  return function (file) {
    var key = [pullRequest.owner, pullRequest.repo, pullRequestRecord.base.sha, file.filename].join('-');
    return Promise.resolve(cache.get(key))
      .then(function (cachedValue) {
        if (cachedValue !== undefined && cacheEnabled) {
          return cachedValue;
        }
        return github.getBlameForCommitFile({
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          //since only modified files are analyzed, the blame for those files is looked up on the original branch
          //of course the files could change significantly on the branch, however this at least filters out otherwise
          //unusable blame data that just points to the branch author
          sha: pullRequestRecord.base.sha,
          path: file.filename
        });
      })
      .then(function (fetchedValue) {
        cache.set(key, fetchedValue, 1000 * 60 * 30);
        return fetchedValue;
      });
  }
}

/**
 * @param  {Object} options
 * @param  {Object} options.github - GitHub client
 * @param  {Object} options.config - Pull Review configuration
 * @param  {String} options.pullReviewConfigPath - Git repo location of Pull Review configuration
 * @param  {String} options.pullRequestURL - pull request URL
 * @param  {Boolean} options.retryReview - unassign current reviewers and assign new reviewers excluding previous reviewers
 * @param  {Boolean} options.isChat - the request is made from a chat context
 * @param  {String} options.chatRoom - the name of the chat room where the request originated
 * @param  {String} options.chatChannel - internal identifier of the chat request originator, e.g. hubot:slack
 * @param  {String} options.userMappingFn - optional function that maps the configured notification username for a reviewer to another username, e.g. a user's full name to the internal Slack user ID
 * @return {Array} list of actions to take
 */
module.exports = function generatePlan(options) {
  options = options || {};
  var actions = [];
  //todo: consider getting rid of the fallback Github client
  var github = options.github || Github(options.githubToken);
  var config = process.env.PULL_REVIEW_CONFIG || options.config;
  var pullReviewConfigPath =
    process.env.PULL_REVIEW_CONFIG_PATH ||
    options.pullReviewConfigPath ||
    '.pull-review';
  var pullRequestURL = options.pullRequestURL;
  var retryReview = Boolean(options.retryReview);
  var isChat = Boolean(options.isChat);
  var chatRoom = options.chatRoom;
  var requiredChatRooms = process.env.PULL_REVIEW_REQUIRED_ROOMS
    ? process.env.PULL_REVIEW_REQUIRED_ROOMS.split(',')
    : [];
  var chatChannel = options.chatChannel;
  var userMappingFn = options.userMappingFn;
  var pullRequestRecord;
  var pullRequestFiles;
  var pullRequestCommits;
  var pullRequestAssignees;
  var newPullRequestAssignees;
  var repoPullReviewConfig;
  var pullRequestLabels;
  var pullRequestReviewRequests;
  var useReviewRequests = false;
  var notifySlack = (process.env.PULL_REVIEW_NOTIFY_SLACK || 'true').toLowerCase() === 'true';
  var notifyGithub = (process.env.PULL_REVIEW_NOTIFY_GITHUB || 'true').toLowerCase() === 'true';

  if (!pullRequestURL) {
    throw Error('Missing pull request URL');
  }

  var pullRequest = github.parseGithubURL(pullRequestURL);

  if (!pullRequest) {
    throw Error('Invalid pull request URL');
  } else if (
    isChat &&
    chatRoom &&
    requiredChatRooms.length &&
    requiredChatRooms.indexOf(chatRoom) === -1
  ) {
    throw Error('Review requests are disabled from room ' + chatRoom);
  }

  return github
    .getPullRequest(pullRequest)
    .catch(function() {
      throw Error('Failed to get pull request: ' + pullRequestURL);
    })
    .then(function(res) {
      pullRequestRecord = res;

      if (pullRequestRecord.state !== 'open') {
        throw Error('Pull request is not open: ' + pullRequestURL);
      }

      return Promise.all([
        github.getPullRequestFiles(pullRequest),
        github.getPullRequestCommits(pullRequest),
        github.getPullRequestLabels(pullRequest),
        github.getReviewRequests(pullRequest),
        config
          ? null
          : getPullReviewConfig(github, pullRequest, pullReviewConfigPath)
      ]);
    })
    .then(function(res) {
      pullRequestFiles = res[0];
      pullRequestCommits = res[1];
      pullRequestLabels = res[2];
      pullRequestReviewRequests = res[3];
      repoPullReviewConfig = res[4];
      config = config || repoPullReviewConfig;

      if (!config) {
        throw Error('Missing configuration');
      }

      config = Config(config);

      useReviewRequests = Boolean(config.useReviewRequests);

      if (useReviewRequests) {
        pullRequestAssignees = pullRequestReviewRequests.users;
      } else if (pullRequestRecord.assignees) {
        pullRequestAssignees = pullRequestRecord.assignees;
      } else if (pullRequestRecord.assignee) {
        pullRequestAssignees = [pullRequestRecord.assignee];
      }

      if (Array.isArray(pullRequestAssignees) && pullRequestAssignees.length) {
        pullRequestAssignees = pullRequestAssignees.map(function(assignee) {
          return assignee.login;
        });
      }

      if (retryReview) {
        actions.push(
          Action({
            type: useReviewRequests
              ? 'DELETE_REVIEW_REQUESTS'
              : 'UNASSIGN_USERS_FROM_PULL_REQUEST',
            payload: {
              pullRequest: pullRequest,
              assignees: pullRequestAssignees
            }
          })
        );
      }

      return getReviewers({
        config: config,
        files: pullRequestFiles,
        commits: pullRequestCommits,
        labels: pullRequestLabels,
        authorLogin: pullRequestRecord.user.login,
        assignees: pullRequestAssignees,
        retryReview: retryReview,
        getBlameForFile: getBlameForFile(github, pullRequest, pullRequestRecord)
      });
    })
    .then(function(reviewers) {
      if (!reviewers || !reviewers.length) {
        throw Error('No reviewers found: ' + pullRequestURL);
      }

      newPullRequestAssignees = reviewers.map(function(reviewer) {
        return reviewer.login;
      });

      var channels = [];

      if (isChat && chatChannel && notifySlack) {
        channels.push(chatChannel);
      }

      if (notifyGithub) {
        channels.push('github');
      }

      actions.push(
        Action({
          type: useReviewRequests
            ? 'CREATE_REVIEW_REQUEST'
            : 'ASSIGN_USERS_TO_PULL_REQUEST',
          payload: {
            pullRequest: pullRequest,
            assignees: newPullRequestAssignees,
            reviewers: reviewers
          }
        })
      );

      channels.forEach(function(channel) {
        var channelUsers = reviewers.map(function(reviewer) {
          if (channel === 'hubot:slack') {
            var slackUser = reviewer.notify.slack;
            return userMappingFn
              ? userMappingFn(slackUser, reviewer.login)
              : slackUser;
          }

          return reviewer.login;
        });

        actions.push(
          Action({
            type: 'NOTIFY',
            payload: {
              pullRequest: pullRequest,
              pullRequestRecord: pullRequestRecord,
              users: channelUsers,
              channel: channel
            }
          })
        );
      });

      return actions;
    });
};
