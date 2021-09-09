import * as cdk from '@aws-cdk/core';

import * as ec2 from '@aws-cdk/aws-ec2';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import { HttpApi, HttpMethod } from '@aws-cdk/aws-apigatewayv2';
import { HttpAlbIntegration } from '@aws-cdk/aws-apigatewayv2-integrations';
import { ApplicationProtocol, ApplicationTargetGroup, TargetType } from '@aws-cdk/aws-elasticloadbalancingv2';
import {InstanceIdTarget} from '@aws-cdk/aws-elasticloadbalancingv2-targets';
import { Port } from '@aws-cdk/aws-ec2';

import * as cognito from '@aws-cdk/aws-cognito';
import {HttpUserPoolAuthorizer} from '@aws-cdk/aws-apigatewayv2-authorizers';
import { OAuthScope, UserPoolClient } from '@aws-cdk/aws-cognito';


/* This code assumes that Security Group is already created for ALB since Kafka rest proxy instance is created by Terraform and 
security group of that ec2 instance should add traffic from sg of ALB  */

export class KafkaRestProxyApiCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const instanceId = 'i-04541f167f6131df2';
    const ec2Port = 8082;
    const sgKafkaProxyEc2 = 'sg-08f04b435a3fc5375'


    const vpc = ec2.Vpc.fromLookup(this, 'msk', {vpcId: "vpc-0ce8ea63163195679"});
    
    // Setting up Security Group and Load balancer
    const sgForKafkaProxyEc2 = ec2.SecurityGroup.fromLookup(this, 'sgForKafkaProxyEc2', sgKafkaProxyEc2 );
    const sg = new ec2.SecurityGroup(this,'sg', {
      vpc,
      securityGroupName: 'Kafka ALB SG',
      description: 'Security group for Kafka ALB',
      allowAllOutbound: true,
    });

    sg.connections.allowFrom(sg, Port.allTcp(), 'Allow traffic from self');
    sgForKafkaProxyEc2.connections.allowFrom(sg, Port.tcp(ec2Port), 'Allow traffif from Kafka ALB');

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc,
      internetFacing: false,
      securityGroup: sg
    });

    const tg = new ApplicationTargetGroup(this, 'tg', {
      targetGroupName: 'tgForKafkaProxy',
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.INSTANCE,
      targets: [new InstanceIdTarget(instanceId, ec2Port)],
      vpc,
    });

    const listener = lb.addListener('listener', {
      port: 80,
      defaultTargetGroups: [tg],
    });

    // Setting up user pool, resuorce server and client
    const userPool = new cognito.UserPool(this, 'apiUserPool', {
      userPoolName: 'kafka-api-userpool',
    }); 

    new cognito.CfnUserPoolResourceServer(this, 'dev-userpool-resource-server', {
      identifier: 'https://resource-server/',
      name: 'dev-userpool-resource-server',
      userPoolId: userPool.userPoolId,
      scopes: [
        {
          scopeDescription: 'Post message to kafka',
          scopeName: 'post-kafka',
        },
      ],
    });

    const userPoolClient= userPool.addClient('apiUserPoolClient', {
      generateSecret: true,
      oAuth: {
        flows: {
          clientCredentials: true,
        },
      scopes: [OAuthScope.custom('https://resource-server//post-kafka')],
      },
    });

    userPool.addDomain('cognitoDomain', {
      cognitoDomain: {
        domainPrefix: 'kafkarestapiproxy'
      }
    });

    const authorizer = new HttpUserPoolAuthorizer({
      userPool,
      userPoolClient
    });

    // Setting up API Gateway
    const httpEndpoint = new HttpApi(this, 'KafkaProxyPrivateApi', {
      apiName: 'kafkaRestProxy', 
      description: 'API for Kafka REST Proxy',
      defaultAuthorizationScopes: ['https://resource-server//post-kafka'],
    });

    httpEndpoint.addRoutes({
      path: "/topics/TestTopic",
      methods : [HttpMethod.POST],
      integration : new HttpAlbIntegration({
        listener,
        method: HttpMethod.POST }),
      authorizer,
    });
  }
}
