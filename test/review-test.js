var fs = require('fs');
var path = require('path');

var Helper = require('hubot-test-helper');
var nock = require('nock');
var chai = require('chai');
chai.use(require('chai-as-promised'));
chai.should();

var config = fs.readFileSync(path.join(__dirname, 'pull-review', 'config.yml'), 'utf8');

var url = require('../src/url');
var github = require('../src/github');
var Request = require('../src/request');
var Review = require('../src/review');
var HubotReview = require('../src/hubot-review');
var messages = require('../src/messages');
var GenericMessage = messages.GenericMessage;
var SlackMessage = messages.SlackMessage;
var GitHubMessage = messages.GitHubMessage;

var helper = new Helper('../index.js');

var ghapi = nock('https://api.github.com');

function mockNotFound(api, url) {
  return api.get(url).reply(404, {
    'message': 'Not Found'
  });
}

function mockFile(api, url, options) {
  return api.get(url).reply(200, {
    'name': options.name,
    'path': options.path,
    'encoding': 'base64',
    'content': (new Buffer(options.content || '', 'utf8')).toString('base64')
  });
}

function mockConfig(api, url) {
  return mockFile(api, url, {
    'name': 'config',
    'path': 'config',
    'content': config
  });
}

function mockGitHubPullRequest(api, url, options) {
  var split = url.split('/');
  var owner = split[2];
  var repo = split[3];
  var number = split[5];
  options = options || {};

  var login = options.login || 'mockuser';
  var state = options.state || 'open';

  return api.get(url).reply(200, {
    'html_url': ['https://mockhub.com', owner, repo, 'pull', number].join('/'),
    'number': number,
    'state': state,
    'title': 'Lorem ipsum',
    'body': options.body || 'Hello world',
    'assignee': options.assignee || undefined,
    'assignees': options.assignees || undefined,
    'user': {
      'login': login,
      'html_url': ['https://mockhub.com', login].join('/')
    },
    'head': {
      'sha': 'deadbeef'
    }
  });
};

function mockGitHubPullRequestFiles(api, url, options) {
  var split = url.split('/');
  var owner = split[2];
  var repo = split[3];
  var number = split[5];
  options = options || {};

  return api.get(url).reply(200, [
    {
      'filename': 'added_file.txt',
      'status': 'added',
      'changes': 999
    },
    {
      'filename': 'modified_file_1.txt',
      'status': 'modified',
      'changes': 1
    },
    {
      'filename': 'modified_file_2.txt',
      'status': 'modified',
      'changes': 2
    },

    {
      'filename': 'modified_file_3.txt',
      'status': 'modified',
      'changes': 3
    },
    {
      'filename': 'deleted_file.txt',
      'status': 'deleted',
      'changes': 999
    }
  ]);
}

function mockGraphQLBlame(api, url, options) {
  options = options || {};

  return api.post(url).reply(200, {
    'data': {
      'repository': {
        'object': {
          'blame': {
            'ranges': [
              {
                'startingLine': 1,
                'endingLine': 10,
                'age': 1,
                'commit': {
                  'author': {
                    'user': {
                      'login': 'mockuser'
                    }
                  }
                }
              },
              {
                'startingLine': 11,
                'endingLine': 12,
                'age': 10,
                'commit': {
                  'author': {
                    'user': {
                      'login': 'mockuser2'
                    }
                  }
                }
              },
              {
                'startingLine': 13,
                'endingLine': 15,
                'age': 2,
                'commit': {
                  'author': {
                    'user': {
                      'login': 'mockuser'
                    }
                  }
                }
              },
              {
                'startingLine': 16,
                'endingLine': 16,
                'age': 1,
                'commit': {
                  'author': {
                    'user': {
                      'login': 'mockuser2'
                    }
                  }
                }
              },
              {
                'startingLine': 17,
                'endingLine': 25,
                'age': 3,
                'commit': {
                  'author': {
                    'user': {
                      'login': 'mockuser'
                    }
                  }
                }
              },
              {
                'startingLine': 25,
                'endingLine': 26,
                'age': 9,
                'commit': {
                  'author': {
                    'user': {
                      'login': 'mockuser3'
                    }
                  }
                }
              }
            ]
          }
        }
      }
    }
  })
}

describe('(unit)', function () {
  describe('url', function () {
    describe('#parseURL', function () {
      it('parses URLs correctly', function () {
        var uo = url.parseURL('https://example.com/abc/xyz?123#foo');
        uo.host.should.equal('example.com');
      });
    });

    describe('#extractURLs', function () {
      it('extracts URLs correctly', function () {
        var text = 'go to http://example.com, then go to https://foobar.xyz?abc=123.';
        var urls = url.extractURLs(text);
        urls[0].should.equal('http://example.com');
        urls[1].should.equal('https://foobar.xyz/?abc=123');
      });
    });
  });

  describe('Request', function () {
    it('identifies reviews correctly', function () {
      var r = Request({'text': 'review https://github.com/abc/pull/1'});
      r.should.have.ownProperty('isReview');
      r.isReview.should.be.true;
      r.githubURLs[0].href.should.equal('https://github.com/abc/pull/1');

      var r = Request({'text': 'Review https://github.com/abc/pull/1'});
      r.should.have.ownProperty('isReview');
      r.isReview.should.be.true;
      r.githubURLs[0].href.should.equal('https://github.com/abc/pull/1');
    });

    it('identifies non-reviews correctly', function () {
      var r = Request({'text': 'https://github.com/abc/pull/1, https://github.com/xyz/pull/2'});
      r.isReview.should.be.false;
      r.githubURLs.should.have.lengthOf(2);

      var r = Request({'text': 'review https://example.com/xyz/pull/2'});
      r.isReview.should.be.false;
      r.githubURLs.should.be.empty;
    });

    it('de-duplicates resources', function () {
      var r = Request({'text': 'https://github.com/abc/pull/1, https://github.com/abc/pull/1'});
      r.githubURLs.should.have.lengthOf(1);
    });
  });

  describe('github', function () {
    afterEach(function () {
      return nock.cleanAll();
    });

    it('#getGithubResources', function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/2');

      var r = Request({'text': 'https://github.com/OWNER/REPO/pull/1 and https://github.com/OWNER/REPO/pull/2 '});
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          resources.should.have.lengthOf(2);
          resources[1].number.should.equal('2');
        });
    });

    it('#getPullRequestFiles', function () {
      mockGitHubPullRequestFiles(ghapi, '/repos/OWNER/REPO/pulls/1/files?per_page=100');

      return github.getPullRequestFiles({
        'owner': 'OWNER',
        'repo': 'REPO',
        'number': 1
      })
        .then(function (files) {
          files.should.not.be.empty;
          files.should.have.lengthOf(5);
        });
    });


    describe('#assignUsersToResource', function () {
      it('works correctly', function () {
        ghapi.post('/repos/OWNER/REPO/issues/1/assignees').reply(200);

        return github.assignUsersToResource({
          'owner': 'OWNER',
          'repo': 'REPO',
          'number': '1'
        }, ['test']);
      });

      it('fails with non-text assignees', function () {
        (function () {
          github.assignUsersToResource({
            'owner': 'OWNER',
            'repo': 'REPO',
            'number': '1'
          }, [{}]);
        }).should.throw(Error, 'Assignees must be specified as strings');
      });
    });

    it('#getRepoFile', function () {
      mockFile(ghapi, '/repos/OWNER/REPO/contents/file.txt', {
        'content': 'Hello world'
      });

      return github.getRepoFile({
        'owner': 'OWNER',
        'repo': 'REPO'
      }, 'file.txt', 'utf8')
        .then(function (res) {
          res.should.equal('Hello world');
        })
    });

    it('#getBlameForCommitFile');
    it('#postPullRequestComment');
    it('#unassignUsersFromResource');
  });

  describe('Review', function () {
    afterEach(function () {
      return nock.cleanAll();
    });

    it('bails when input request is not a review', function () {
      var r = Request({'text': 'https://github.com/OWNER/REPO/pull/1'});
      var review = Review({'request': r});
      return review.then(function (res) {
        (res === null).should.be.true;
      });
    });

    it('fails with PRs that are not found', function () {
      mockNotFound(ghapi, '/repos/OWNER/REPO/pulls/1');
      var r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1'});
      var review = Review({'request': r});
      return review.should.eventually.be.rejectedWith(Error, '{"message":"Not Found"}');
    });

    it('fails without exactly one open GitHub pull request with user data', function () {
      var r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1  https://github.com/OWNER/REPO/pull/2'});

      var tooManyPRs = Review({'request': r});

      r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1'});
      r.githubURLs = [];

      var notEnoughPRs = Review({'request': r});

      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1', {
        'state': 'closed'
      });

      r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1'});
      var closedPR = Review({'request': r});

      return Promise.all([
        tooManyPRs.should.eventually.be.rejectedWith(Error, 'Only one GitHub URL can be reviewed at a time'),
        notEnoughPRs.should.eventually.be.rejectedWith(Error, 'No GitHub URLs'),
        closedPR.should.eventually.be.rejectedWith(Error, 'Pull request is not open')
      ]);
    });

    it('adds only up to max reviewers if assignees are present', function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1', {
        'assignee': {
          'login': 'someuser'
        },
      });
      mockGitHubPullRequestFiles(ghapi, '/repos/OWNER/REPO/pulls/1/files?per_page=100');
      mockGraphQLBlame(ghapi, '/graphql');
      mockConfig(ghapi, '/repos/OWNER/REPO/contents/.pull-review');

      var r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1'});
      return Review({'request': r})
        .then(function (res) {
          res.reviewers.should.have.lengthOf(2);
        });
    });

    it('unassigns reviewers when a "review again" request is made', function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1', {
        'assignees': [
          {
            'login': 'someuser'
          },
          {
            'login': 'anotheruser'
          }
        ]
      });
      mockGitHubPullRequestFiles(ghapi, '/repos/OWNER/REPO/pulls/1/files?per_page=100');
      mockGraphQLBlame(ghapi, '/graphql');
      mockConfig(ghapi, '/repos/OWNER/REPO/contents/.pull-review');
      ghapi.delete('/repos/OWNER/REPO/issues/1/assignees').reply(200);

      var r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1 again'});
      return Review({'request': r})
        .then(function (res) {
          res.reviewers.should.have.lengthOf(2);
          res.reviewers[0].login.should.not.equal('someuser');
        });
    });
  });

  describe('generic message', function () {
    var r = Request({'text': 'https://github.com/OWNER/REPO/pull/1 and https://github.com/OWNER/REPO/pull/2 '});
    var reviewers = [{'login': 'foo'}, {'login': 'bar'}];

    beforeEach(function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/2');
    });

    afterEach(function () {
      return nock.cleanAll();
    });

    it('outputs an error when provided', function () {
      var message = GenericMessage({'error': 'test'});
      message.should.equal('test');
    });

    it('outputs a review message', function () {
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          var message = GenericMessage({
            'reviewers': reviewers,
            'resources': resources
          });

          message.should.equal('Assigning @foo, @bar to OWNER/REPO#1');
        });
    });

    it('outputs a review message using a reviewer map', function () {
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          var message = GenericMessage({
            'reviewers': reviewers,
            'resources': resources,
            'reviewerMap': {
              'foo': 'uvw',
              'bar': 'xyz'
            }
          });

          message.should.equal('Assigning @uvw, @xyz to OWNER/REPO#1');
        });
    });

    it('outputs nothing without reviewers', function () {
      var message = GenericMessage({'reviewers': null});
      (message === undefined).should.be.true;
    });
  });

  describe('Slack message', function () {
    var r = Request({'text': 'https://github.com/OWNER/REPO/pull/1 and https://github.com/OWNER/REPO/pull/2'});

    beforeEach(function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/2');
    });

    afterEach(function () {
      return nock.cleanAll();
    });

    it('outputs a non-review message', function () {
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          var message = SlackMessage({
            'resources': resources
          });

          var attachments = message.attachments;
          attachments[0].fallback.should.equal('Lorem ipsum by mockuser: https://mockhub.com/OWNER/REPO/pull/1');
          attachments[0].title.should.equal('OWNER/REPO: Lorem ipsum');
          attachments[1].fallback.should.equal('Lorem ipsum by mockuser: https://mockhub.com/OWNER/REPO/pull/2');
          attachments[1].title.should.equal('OWNER/REPO: Lorem ipsum');
        });
    });

    it('outputs an image if one is available in PR body', function () {
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          resources = resources.map(function (resource) {
            resource.data = {
              'user': {},
              'body': 'http://example.com/example.png'
            };

            return resource;
          });

          var message = SlackMessage({
            'resources': resources
          });

          var attachments = message.attachments;
          attachments[0].text.should.equal('');
          attachments[0].image_url.should.equal('http://example.com/example.png');
        });
    });

    it('outputs an image if one is available in Markdown PR body', function () {
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          resources = resources.map(function (resource) {
            resource.data = {
              'user': {},
              'body': [
                '![foo](http://example.com/foo.png)',
                '![bar](http://example.com/bar.png)'
                ].join('\n')
            };

            return resource;
          });

          var message = SlackMessage({
            'resources': resources
          });

          var attachments = message.attachments;
          attachments[0].text.should.equal('');
          attachments[0].image_url.should.equal('http://example.com/foo.png');
        });
    });

    it('outputs a review message', function () {
      var r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1'});
      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          var reviewers = [{'login': 'foo'}, {'login': 'bar'}];
          var message = SlackMessage({
            'resources': resources,
            'reviewers': reviewers
          });

          message.text.should.equal('@foo, @bar: please review this pull request');
          message.should.have.ownProperty('attachments');
        });
    });
  });

  describe('GitHub message', function () {
    beforeEach(function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
    });

    afterEach(function () {
      return nock.cleanAll();
    });

    it('does not output a non-review message', function () {
      var r = Request({'text': 'https://github.com/OWNER/REPO/pull/1'});

      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          var message = GitHubMessage({
            'resources': resources
          });

          (message === undefined).should.be.true;
        });
    });

    it('outputs a review message', function () {
      var r = Request({'text': 'review https://github.com/OWNER/REPO/pull/1'});
      var reviewers = [{'login': 'foo'}, {'login': 'bar'}];

      return github.getGithubResources(r.githubURLs)
        .then(function (resources) {
          var message = GitHubMessage({
            'resources': resources,
            'reviewers': reviewers
          });

          message.should.equal('@foo, @bar: please review this pull request');
        });
    });
  });
});

describe('(integration)', function () {
  describe('HubotReview', function () {
    describe('using default adapter', function () {
      afterEach(function () {
        delete process.env.HUBOT_REVIEW_REQUIRED_ROOMS;
        return nock.cleanAll();
      });

      it('works correctly', function () {
        mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
        mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
        mockGitHubPullRequestFiles(ghapi, '/repos/OWNER/REPO/pulls/1/files?per_page=100');
        mockGraphQLBlame(ghapi, '/graphql');
        mockGraphQLBlame(ghapi, '/graphql');
        mockGraphQLBlame(ghapi, '/graphql');
        ghapi.post('/repos/OWNER/REPO/issues/1/assignees').reply(200);
        ghapi.post('/repos/OWNER/REPO/issues/1/comments', "{\"body\":\"@mockuser2, @mockuser3: please review this pull request\"}\n").reply(200);
        mockConfig(ghapi, '/repos/OWNER/REPO/contents/.pull-review');

        return HubotReview({'text': 'review https://github.com/OWNER/REPO/pull/1'})
          .then(function (res) {
            res.should.contain('Assigning @mockuser2, @mockuser3 to OWNER/REPO#1');
          })
      });

      it('fails for issues', function () {
        mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/issues/1');
        mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/issues/1');

        return HubotReview({'text': 'review https://github.com/OWNER/REPO/issues/1'})
          .then(function (res) {
            (res instanceof Error).should.be.true;
            res.message.should.equal('Reviews for resources other than pull requests are not supported');
          });
      });

      it('fails for inaccessible PRs', function () {
        mockNotFound(ghapi, '/repos/OWNER/REPO/pulls/404');
        mockNotFound(ghapi, '/repos/OWNER/REPO/pulls/404');

        return HubotReview({'text': 'review https://github.com/OWNER/REPO/pull/404'})
          .then(function (res) {
            (res instanceof Error).should.be.true;
            res.message.should.equal('{"message":"Not Found"}');
          });
      });

      it('fails if review is requested from disabled room', function () {
        process.env.HUBOT_REVIEW_REQUIRED_ROOMS = 'foobar';
        return HubotReview({'room': 'test', 'text': 'review https://github.com/OWNER/REPO/pull/404'})
          .should.eventually.be.rejectedWith(Error, 'Review requests from this room are disabled');
      });
    });

    describe('using Slack adapter', function () {
      beforeEach(function () {
        mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
      });

      afterEach(function () {
        return nock.cleanAll();
      });

      it('works correctly with review messages', function () {
        mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
        mockGitHubPullRequestFiles(ghapi, '/repos/OWNER/REPO/pulls/1/files?per_page=100');
        mockGraphQLBlame(ghapi, '/graphql');
        mockGraphQLBlame(ghapi, '/graphql');
        mockGraphQLBlame(ghapi, '/graphql');
        ghapi.post('/repos/OWNER/REPO/issues/1/assignees').reply(200);
        ghapi.post('/repos/OWNER/REPO/issues/1/comments', "{\"body\":\"@mockuser2, @mockuser3: please review this pull request\"}\n").reply(200);
        mockConfig(ghapi, '/repos/OWNER/REPO/contents/.pull-review');

        return HubotReview({'adapter': 'slack', 'text': 'review https://github.com/OWNER/REPO/pull/1'})
          .then(function (res) {
            res.should.have.ownProperty('text');
            res.text.should.equal('@foo, @bar: please review this pull request');
            res.should.have.ownProperty('attachments');
            res.attachments.should.have.lengthOf(1);
          })
      });

      it('works correctly with non-review messages', function () {
        return HubotReview({'adapter': 'slack', 'text': 'https://github.com/OWNER/REPO/pull/1'})
          .then(function (res) {
            res.should.have.ownProperty('attachments');
            res.attachments.should.have.lengthOf(1);
          });
        });
    })
  });

  describe('Hubot', function () {
    var room;

    beforeEach(function () {
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
      mockGitHubPullRequest(ghapi, '/repos/OWNER/REPO/pulls/1');
      mockGitHubPullRequestFiles(ghapi, '/repos/OWNER/REPO/pulls/1/files?per_page=100');
      mockGraphQLBlame(ghapi, '/graphql');
      mockGraphQLBlame(ghapi, '/graphql');
      mockGraphQLBlame(ghapi, '/graphql');
      ghapi.post('/repos/OWNER/REPO/issues/1/assignees').reply(200);
      ghapi.post('/repos/OWNER/REPO/issues/1/comments', "{\"body\":\"@mockuser2, @mockuser3: please review this pull request\"}\n").reply(200);
      mockConfig(ghapi, '/repos/OWNER/REPO/contents/.pull-review');

      room = helper.createRoom({
        'name': 'test'
      });
    });

    afterEach(function () {
      return room.destroy();
    });

    it('works correctly', function (done) {
      return room.user.say('alice', 'review https://github.com/OWNER/REPO/pull/1 please')
        .then(function () {
          setTimeout(function () {
            room.messages.should.have.lengthOf(2);
            room.messages[1][1].should.equal('Assigning @mockuser2, @mockuser3 to OWNER/REPO#1');
            done();
          }, 500);
        });
    });
  });
});
