import {EventEmitter} from "events";

const instagram = require('instagram-private-api');
const Bluebird = require('bluebird');
const inquirer = require('inquirer');
const fs = require('fs');
const schedule = require('node-schedule');
const requestPromise = require('request-promise');
import * as util from "util";
require('dotenv').config();

if (!fs.existsSync('download/')) fs.mkdirSync('download');

let refreshSchedule;
let ig;
util.inspect.defaultOptions.maxArrayLength = null;
const igUser = process.env.IG_USERNAME;
// const igPass = process.env.IG_PASSWORD;
const storyUserPk = process.env.STORY_USER_PK;
const loopInterval : number = +process.env.LOOP_INTERVAL;

(async () => {
    // needed only for production version
    // const { igUser } = await inquirer.prompt([
    //     {
    //         type: 'input',
    //         name: 'igUser',
    //         message: 'Username',
    //     },
    // ]);
    console.log("Username: " + igUser);
    const { igPass } = await inquirer.prompt([
        {
            type: 'password',
            name: 'igPass',
            message: 'Password',
        },
    ]);
    // const { storyUserPk } = await inquirer.prompt([
    //     {
    //         type: 'input',
    //         name: 'storyUserPk',
    //         message: 'User story Pk',
    //     },
    // ]);

    ig = new instagram.IgApiClient();
    ig.state.generateDevice(igUser);

    Bluebird.try(async () => {
        const auth = await ig.account.login(igUser, igPass);
        console.log("Logged in as: ", auth.username);
        console.log('\n');
    }).catch(instagram.IgLoginTwoFactorRequiredError, async (e) => {
        console.log("User has Two Factor Authentication enabled.");
        const {username, totp_two_factor_on, two_factor_identifier} = e.response.body.two_factor_info;
        // decide which method to use
        const verificationMethod = totp_two_factor_on ? '0' : '1'; // default to 1 for SMS
        // At this point a code should have been sent
        // Get the code
        const {code} = await inquirer.prompt([
            {
                type: 'input',
                name: 'code',
                message: `Enter code received via ${verificationMethod === '1' ? 'SMS' : 'TOTP'}`,
            },
        ]);
        // Use the code to finish the login process
        const auth = await ig.account.twoFactorLogin({
            username,
            verificationCode: code,
            twoFactorIdentifier: two_factor_identifier,
            verificationMethod, // '1' = SMS (default), '0' = TOTP (google auth for example)
            trustThisDevice: '1', // Can be omitted as '1' is used by default
        });
        console.log("Logged in as: ", auth.username);
        console.log('\n');
    }).catch(instagram.IgCheckpointError, async () => {
        console.log(ig.state.checkpoint);
        await ig.challenge.auto(true);
        console.log(ig.state.checkpoint);
        const { code } = await inquirer.prompt([
            {
                type: 'input',
                name: 'code',
                message: 'Enter code',
            },
        ]);
        console.log(await ig.challenge.sendSecurityCode(code));
    }).catch(e => {
        console.log('Could not resolve login checkpoint:', e, e.stack)
    }).then(async () => {
        let waitSeconds = 5000; // To throttle down requests to the api
        let getStories = async () => {
            console.log("getting user stories");
            let userStoryFeed = ig.feed.userStory(storyUserPk);
            console.log("getting user stories items", new Date().toLocaleTimeString());
            let storyFeedItems = await userStoryFeed.items();
            console.log("storyFeedItems length: ", storyFeedItems.length);
            console.log("STARTING LOOP", new Date().toLocaleTimeString());
            console.log("\n");
            for (let storyFeedItem of storyFeedItems) {
                console.log("START OF THE LOOP FOR: " + storyFeedItem.id, new Date().toLocaleTimeString());
                let mediaId = feedItemIdToMediaId(storyFeedItem.id);
                console.log("SETTING TIMEOUT PROMISE FOR: " + (waitSeconds) + " SECONDS", new Date().toLocaleTimeString());
                await new Promise(r => setTimeout(r, waitSeconds));
                console.log("GETTING MEDIA INFO FOR: " + storyFeedItem.id, new Date().toLocaleTimeString());
                let mediaInfo = await ig.media.info(mediaId);
                if (mediaInfo.items == undefined) continue;
                if (mediaInfo.items[0] == undefined) continue;
                let finalMedia = mediaInfo.items[0];
                console.log("INITIATE DOWNLOAD FOR: " + storyFeedItem.id, new Date().toLocaleTimeString());
                downloadStory(finalMedia);
                console.log("END OF THE LOOP FOR: " + storyFeedItem.id, new Date().toLocaleTimeString());
                console.log("\n");
            }
        };

        await getStories();
        let interval = setInterval(getStories, loopInterval);

        // refreshSchedule = schedule.scheduleJob('*/10 * * * * *', async function (fireDate) {
        //
        // });
    })
})();

function downloadStory(media) {
    var url;
    var filename;
    var extension;
    var username;

    switch (media.media_type) {
        case 1:
            url = media.image_versions2.candidates[0].url;
            filename = media.id;
            extension = 'jpeg';
            username = media.user.username;
            break;
        case 2:
            url = media.video_versions[0].url;
            filename = media.id;
            extension = 'mp4';
            username = media.user.username;
            break;
        default:
            return;
    }

    fs.exists(`download/${username}/${filename}.${extension}`, (alreadyDownloaded) => {
        if (alreadyDownloaded) return;
        requestPromise.get({
            url,
            encoding: null,
            headers: {
                'Accept-Encoding': 'gzip',
                'Connection': 'close',
                'X-FB-HTTP-Engine': 'Liger',
                'User-Agent': ig.state.appUserAgent,
            },
        }).then((mediaData) => {
            fs.exists(`download/${username}/`, (userFolderExists) => {
                if (!userFolderExists) fs.mkdirSync(`download/${username}/`);
                fs.writeFile(`download/${username}/${filename}.${extension}`, mediaData, (err) => {
                    if (err) throw err;
                    console.log(`Downloaded ${username}/${filename}.${extension}`);
                });
            });
        });
    });
}

//converts the id of a feed item to a media id
function feedItemIdToMediaId(string: string): string {
    return string.substring(0, string.indexOf("_"));
}
