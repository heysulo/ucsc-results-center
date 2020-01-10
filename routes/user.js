const express = require('express');
const router = express.Router();

const _ = require('lodash');
const crypto = require('crypto');

const log = require('perfect-logger');
const postman = require('../modules/postman');
const mysql = require('../modules/database.js');
let notificationSettings = require('./notifications/notification-settings');
let permission = require('../modules/permissions');
const messenger = require('../modules/messenger');
const feedback = require('./feedback/feedback');

//Common Queries
let queryValidateIndexNumber = "SELECT `base`.`index` as `indexNumber`, " +
    "IF (`facebook`.`state` IN ('verified', 'pending'), 'conflict', 'available') as state " +
    "FROM (SELECT * FROM `result` WHERE `result`.`index` = ? LIMIT 1) AS `base` " +
    "LEFT OUTER JOIN `facebook` " +
    "ON `facebook`.`index_number` = `base`.`index`;";

// Authentication and Verification Middleware
router.use('/', permission());
router.use('/notifications', notificationSettings);

router.get('/validate', function (req, res) {
    let query = 'INSERT INTO `facebook` (`id`, `name`, `fname`, `lname`, `gender`, `link`, `short_name`, `picture`, `cover`, `index_number`,`state`,`lastvisit`,`email`)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE ' +
        '`lastvisit` = VALUES(lastvisit),' +
        '`name` = VALUES(name),' +
        '`fname` = VALUES(fname),' +
        '`lname` = VALUES(lname),' +
        '`link` = VALUES(link),' +
        '`short_name` = VALUES(short_name),' +
        '`picture` = VALUES(picture),' +
        '`cover` = VALUES(cover),' +
        '`email` = VALUES(email);';
    mysql.query(query,[
        req.facebookVerification.id,
        req.facebookVerification.name,
        req.facebookVerification.first_name,
        req.facebookVerification.last_name,
        req.facebookVerification.gender,
        req.facebookVerification.link,
        req.facebookVerification.short_name,
        req.facebookVerification.picture.data.url,
        req.facebookVerification.cover ? req.facebookVerification.cover.source : '',
        req.facebookVerification.indexNumber,
        req.facebookVerification.state,
        new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
        req.facebookVerification.email
    ],function (error, _payload) {
        if (error){
            log.crit(error.sqlMessage,-(_.assignIn(error,{
                meta: req.facebookVerification,
                env: req.headers.host
            })));
            res.status(500).send({ error: error });
        }else{
            res.send(req.facebookVerification);
        }
    });
});

router.get('/state/:indexNumber',function (req,res) {
    let indexNumber = parseInt(req.params['indexNumber']) || 0;
    mysql.query(queryValidateIndexNumber,[indexNumber],function (error,payload) {
        if (!error){
            if (payload[0]){
                res.send(payload[0]);
            }else{
                res.send({
                    indexNumber : indexNumber,
                    state: 'not-found'
                });
            }
        }else{
            log.crit(error.sqlMessage, _.assignIn(error,{
                meta: req.facebookVerification,
                env: req.headers.host
            }));
            res.status(500).send({ error: error });
        }
    })
});

router.post('/request',function (req,res) {
    let alternateEmail = req.body.email || null;
    let indexNumber = req.body.indexNumber || 0;
    log.debug(`Join request received from ${req.facebookVerification.name}`);
    log.writeData(req.body);

   if(req.facebookVerification.state !== 'guest'){
       res.status(400).send({
           error: {
               code: 0x003,
               message: `Required the requester's state to be \`guest\`, \`${req.facebookVerification.state}\` found.`
           }
       });
       return;
   }

    mysql.query(queryValidateIndexNumber,[indexNumber],function (error,payload) {
        if (!error){
            if (payload[0]){
                let indexNumberDetails = payload[0];
                if (indexNumberDetails.state === 'available'){
                    let query = "UPDATE facebook " +
                            "SET `facebook`.`state`='pending', " +
                                "`facebook`.`index_number` = ?, " +
                                "`facebook`.`alternate_email` = ? " +
                            "WHERE `facebook`.`state`='guest' and `facebook`.`id`=?;";
                    mysql.query(query,[indexNumber, alternateEmail, req.facebookVerification.id],function (error_q2,payload_q2) {
                        if (!error_q2){
                            if (payload_q2.changedRows === 1){
                                res.send({
                                    success: true,
                                    info: payload_q2
                                });
                                messenger.sendToEventSubscribers('user_approval_request',
                                    `New request received from ${req.facebookVerification.name} [${indexNumber}]`);
                            }else{
                                log.crit(payload_q2, _.assignIn(payload_q2,{
                                    meta: req.facebookVerification,
                                    env: req.headers.host,
                                    data: req.body,
                                    endpoint: '/request'
                                }));
                                res.status(500).send({ error: payload_q2 });
                            }
                        }else {
                            log.crit(error_q2.sqlMessage, _.assignIn(error_q2,{
                                meta: req.facebookVerification,
                                env: req.headers.host,
                                data: req.body,
                                endpoint: '/request'
                            }));
                            res.status(500).send({ error: error_q2 });
                        }
                    });
                }else{
                    res.status(400).send({
                        error: {
                            code: 0x002,
                            message: `State of the Index number required to be \`available\`, \`${indexNumberDetails.state}\` found.`
                        }
                    });
                }
            }else{
                res.status(400).send({
                    error: {
                        code: 0x001,
                        message: 'Required field `indexNumber` was not found.'
                    }
                });
            }
        }else{
            log.crit(error.sqlMessage, _.assignIn(error,{
                meta: req.facebookVerification,
                env: req.headers.host
            }));
            res.status(500).send({ error: error });
        }
    })

});

router.post('/privacy',function (req, res) {
    log.debug(`Privacy update request received from ${req.facebookVerification.name}`);
    log.writeData(req.body);
    if (['shared', 'public', 'private'].indexOf(req.body.privacy) === -1){
        res.status(400).send({
            error: `Privacy state should be 'shared', 'public' or 'private'`
        });
        return;
    }

    req.body.showcase = parseInt(req.body.showcase) === 1 ? 1 : 0;
    mysql.query(
        'SELECT `undergraduate`.`privacy` ' +
        'FROM ' +
        '`facebook` ' +
        'JOIN `undergraduate` ' +
        'ON `facebook`.`index_number` = `undergraduate`.`indexNumber` ' +
        'AND `facebook`.`id` = ? ' +
        'AND `facebook`.`state` = \'verified\'',
        [req.facebookVerification.id],
        function (error, payload) {
            if (!error){
                if (payload.length === 1){
                    mysql.query(
                        'UPDATE `undergraduate` SET `privacy` = ?, `user_showcase` = ? WHERE `undergraduate`.`indexNumber` = ?',
                        [req.body.privacy, req.body.showcase, req.facebookVerification.indexNumber],
                        function (error_write, payload_write) {
                            if (!error_write){
                                res.send(payload_write);
                            }else{
                                log.crit(error_write.sqlMessage, _.assignIn(error_write,{
                                    meta: req.facebookVerification,
                                    env: req.headers.host
                                }));
                                res.status(500).send({ error: error_write });
                            }
                        })
                }else{
                    res.status(400).send({ error: 'User must be verified state' });
                }
            }else{
                log.crit(error.sqlMessage, _.assignIn(error,{
                    meta: req.facebookVerification,
                    env: req.headers.host
                }));
                res.status(500).send({ error: error });
            }
        })
});

router.get('/privacy',function (req, res) {
    mysql.query(
        'SELECT `undergraduate`.`privacy`, `undergraduate`.`user_showcase` as `userShowCase`' +
        'FROM ' +
        '`facebook` ' +
        'JOIN `undergraduate` ' +
        'ON `facebook`.`index_number` = `undergraduate`.`indexNumber` ' +
        'AND `facebook`.`id` = ? ' +
        'AND `facebook`.`state` = \'verified\'',
        [req.facebookVerification.id],
        function (error, payload) {
            if (!error){
                if (payload.length === 1){
                    res.send(payload[0]);
                }else{
                    res.status(400).send({ error: 'User must be verified state' });
                }
            }else{
                log.crit(error.sqlMessage, _.assignIn(error,{
                    meta: req.facebookVerification,
                    env: req.headers.host
                }));
                res.status(500).send({ error: error });
            }
        })
});

router.get('/public-profile',function (req, res) {
    mysql.query(
        'SELECT `undergraduate`.`public_api` as `publicAPI`' +
        'FROM ' +
        '`facebook` ' +
        'JOIN `undergraduate` ' +
        'ON `facebook`.`index_number` = `undergraduate`.`indexNumber` ' +
        'AND `facebook`.`id` = ? ' +
        'AND `facebook`.`state` = \'verified\'',
        [req.facebookVerification.id],
        function (error, payload) {
            if (!error){
                if (payload.length === 1){
                    let privacyOptions = {
                        enabled: false,
                        showName: false,
                        showRank: false
                    };

                    try {
                        const parsedData = JSON.parse(payload[0].publicAPI);
                        privacyOptions = Object.assign(privacyOptions, parsedData)
                    }
                    catch (e) {}
                    res.send(privacyOptions);
                }else{
                    res.status(400).send({ error: 'User must be verified state' });
                }
            }else{
                log.crit(error.sqlMessage, _.assignIn(error,{
                    meta: req.facebookVerification,
                    env: req.headers.host
                }));
                res.status(500).send({ error: error });
            }
        })
});

router.post('/public-profile',function (req, res) {
    log.debug(`Public Profile update request received from ${req.facebookVerification.name}`);

    let privacyOptions = {
        enabled: req.body.enabled === true,
        showName: req.body.showName === true,
        showRank: req.body.showRank === true
    };

    mysql.query(
        'SELECT `undergraduate`.`privacy` ' +
        'FROM ' +
        '`facebook` ' +
        'JOIN `undergraduate` ' +
        'ON `facebook`.`index_number` = `undergraduate`.`indexNumber` ' +
        'AND `facebook`.`id` = ? ' +
        'AND `facebook`.`state` = \'verified\'',
        [req.facebookVerification.id],
        function (error, payload) {
            if (!error){
                if (payload.length === 1){
                    mysql.query(
                        'UPDATE `undergraduate` SET `public_api` = ? WHERE `undergraduate`.`indexNumber` = ?',
                        [JSON.stringify(privacyOptions), req.facebookVerification.indexNumber],
                        function (error_write, payload_write) {
                            if (!error_write){
                                res.send(payload_write);
                            }else{
                                log.crit(error_write.sqlMessage, _.assignIn(error_write,{
                                    meta: req.facebookVerification,
                                    env: req.headers.host
                                }));
                                res.status(500).send({ error: error_write });
                            }
                        })
                }else{
                    res.status(400).send({ error: 'User must be verified state' });
                }
            }else{
                log.crit(error.sqlMessage, _.assignIn(error,{
                    meta: req.facebookVerification,
                    env: req.headers.host
                }));
                res.status(500).send({ error: error });
            }
        })
});

router.get('/admins', function (req, res) {
    const query = "SELECT `name`,`picture`,`power`, (`index_number` LIKE ?) as batchRep FROM `facebook` WHERE `power` > 10 ORDER BY `power` DESC";
    mysql.query(query, [(req.facebookVerification.indexNumber || '00').toString().substr(0,2) + '%'], function (err, payload) {
        if (!err){
            res.send(payload);
        }else {
            log.crit(err.sqlMessage, _.assignIn(err,{
                meta: req.facebookVerification,
                env: req.headers.host
            }));
            res.status(500).send({ error: err });
        }
    })
});

router.get('/admins/:power', function (req, res) {
    let power = parseInt(req.params['power']) || 100;
    const query = "SELECT `name`,`picture`,`power` FROM `facebook` WHERE `power` >= ? ORDER BY `power` DESC, `id` ASC";
    mysql.query(query, [power], function (err, payload) {
        if (!err){
            res.send(payload);
        }else {
            log.crit(err.sqlMessage, _.assignIn(err,{
                meta: req.facebookVerification,
                env: req.headers.host
            }));
            res.status(500).send({ error: err });
        }
    })
});

router.delete('/delete', function (req, res) {
    const query = "DELETE FROM facebook WHERE id=?";
    mysql.query(query,[req.facebookVerification.id], function(err,payload){
        if(!err){
            if(payload.affectedRows === 0) {
                res.status(404).send({});
                log.debug(`${req.facebookVerification.name} (@${req.facebookVerification.id}) profile not found for deletion.`);
            }else{
                res.send(payload);
                log.info(`User profile ${req.facebookVerification.name}(@${req.facebookVerification.state}) deleted as requested.`);
                if (req.facebookVerification.indexNumber){
                    mysql.query(
                        'UPDATE `undergraduate` SET `privacy` = \'public\', `user_showcase` = 0, `public_api` = NULL WHERE `undergraduate`.`indexNumber` = ?',
                        [req.facebookVerification.indexNumber],
                        function (error_write, payload_write) {
                            if (!error_write){
                                log.debug(`Privacy of index number ${req.facebookVerification.indexNumber} was set to Public as the profile is deleted`);
                            }else{
                                log.crit(error_write.sqlMessage, _.assignIn(error_write,{
                                    meta: req.facebookVerification,
                                    env: req.headers.host
                                }));
                            }
                        });
                }

            }
        }else{
            log.crit(err.sqlMessage, _.assignIn(err,{
                meta: req.facebookVerification,
                env: req.headers.host,
                }));
            res.status(500).send({error:err});
        }

    });

});

router.use('/feedback', feedback);

module.exports = router;
